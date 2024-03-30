---
title: "Optimizing Kubernetes NodePort Service: Solving NodePort Range Exhaustion"
date: 2024-03-30 20:01:34 +0000
categories:
  - CSIE
  - Kubernetes
tags:
  - kubernetes
  - nlb
  - eks
  - nodeport
---

## Introduction

When deploying application on Kubernetes cluster, people may use `NodePort` service to make their application accessible. Encountering the error message `failed to allocate a nodePort: range is full` during `NodePort` service creation prompts users to investigate the number of existing `NodePort` services in their cluster. This article dives into the potential reasons behind this error and offers troubleshooting solutions.

## NodePort Service

Kubernetes offers various ways to expose the service within a cluster, including service and ingress. There are four types of Kubernetes services:
- `ClusterIP`: a virtual IP allowing access within the cluster
- `NodePort`: a static port on the node's IP mapping to the pod
- `LoadBalancer`: a external load balancer (For example, NLB on AWS) to distribute the traffic to pods
- `ExternalName`: a DNS CNAME record with a value of another domain name.

### Behind the Scenes of NodePort

With `NodePort`, the kube-proxy will setup the iptables to redirect the packets from the NodePort's port to the respective pods. For instance, consider a `NodePort` service named `nginx-service` with port `31309` on a node mapped to Pod port `80`:

```bash
$ kubectl get svc nginx-service -o wide
NAME            TYPE       CLUSTER-IP       EXTERNAL-IP   PORT(S)        AGE    SELECTOR
nginx-service   NodePort   10.100.250.223   <none>        80:31309/TCP   172d   app=nginx

$ kubectl get svc nginx-service -o yaml
...
...
spec:
  clusterIP: 10.100.250.223
  clusterIPs:
  - 10.100.250.223
  externalTrafficPolicy: Cluster
  internalTrafficPolicy: Cluster
  ipFamilies:
  - IPv4
  ipFamilyPolicy: SingleStack
  ports:
  - nodePort: 31309
    port: 80
    protocol: TCP
    targetPort: 80
  selector:
    app: nginx
  sessionAffinity: None
  type: NodePort
status:
  loadBalancer: {}
```

  Then I can request to the NGINX running in the pod by access the port `31309` on the node. How does it works? A packet destined for port `31309` is routed through iptables chains to the NGINX pod. We can check the iptables rules here below, we can see that:
1. a packet with with destination port 31309 jump to `KUBE-EXT-V2OKYYMBY3REGZOG`
3. `KUBE-EXT-V2OKYYMBY3REGZOG` jump to `KUBE-SVC-V2OKYYMBY3REGZOG`(service)
4. `KUBE-SVC-V2OKYYMBY3REGZOG` jump to different endpoint by random with certain probability, for example `KUBE-SEP-JYWXUEKDFJZ6DYLA`
5. `KUBE-SEP-JYWXUEKDFJZ6DYLA` jump to `192.167.12.215:80` which is one of the NGINX pod

```bash
sh-4.2$ sudo iptables-save | grep "nginx\|V2OKYYMBY3REGZOG"
:KUBE-EXT-V2OKYYMBY3REGZOG - [0:0]
:KUBE-SVC-V2OKYYMBY3REGZOG - [0:0]
-A KUBE-EXT-V2OKYYMBY3REGZOG -m comment --comment "masquerade traffic for default/nginx-service external destinations" -j KUBE-MARK-MASQ
-A KUBE-EXT-V2OKYYMBY3REGZOG -j KUBE-SVC-V2OKYYMBY3REGZOG
-A KUBE-NODEPORTS -p tcp -m comment --comment "default/nginx-service" -m tcp --dport 31309 -j KUBE-EXT-V2OKYYMBY3REGZOG
-A KUBE-SEP-6PTWNGXTF6QI3OX3 -s 192.167.12.127/32 -m comment --comment "default/nginx-service" -j KUBE-MARK-MASQ
-A KUBE-SEP-6PTWNGXTF6QI3OX3 -p tcp -m comment --comment "default/nginx-service" -m tcp -j DNAT --to-destination 192.167.12.127:80
-A KUBE-SEP-DMCJEO2HGIFAABAS -s 192.167.0.17/32 -m comment --comment "default/nginx-service" -j KUBE-MARK-MASQ
-A KUBE-SEP-DMCJEO2HGIFAABAS -p tcp -m comment --comment "default/nginx-service" -m tcp -j DNAT --to-destination 192.167.0.17:80
-A KUBE-SEP-JYWXUEKDFJZ6DYLA -s 192.167.12.215/32 -m comment --comment "default/nginx-service" -j KUBE-MARK-MASQ
-A KUBE-SEP-JYWXUEKDFJZ6DYLA -p tcp -m comment --comment "default/nginx-service" -m tcp -j DNAT --to-destination 192.167.12.215:80
-A KUBE-SEP-Y7L7WSSHDLS5RI3K -s 192.167.5.182/32 -m comment --comment "default/nginx-service" -j KUBE-MARK-MASQ
-A KUBE-SEP-Y7L7WSSHDLS5RI3K -p tcp -m comment --comment "default/nginx-service" -m tcp -j DNAT --to-destination 192.167.5.182:80
-A KUBE-SERVICES -d 10.100.250.223/32 -p tcp -m comment --comment "default/nginx-service cluster IP" -m tcp --dport 80 -j KUBE-SVC-V2OKYYMBY3REGZOG
-A KUBE-SVC-V2OKYYMBY3REGZOG -m comment --comment "default/nginx-service -> 192.167.0.17:80" -m statistic --mode random --probability 0.25000000000 -j KUBE-SEP-DMCJEO2HGIFAABAS
-A KUBE-SVC-V2OKYYMBY3REGZOG -m comment --comment "default/nginx-service -> 192.167.12.127:80" -m statistic --mode random --probability 0.33333333349 -j KUBE-SEP-6PTWNGXTF6QI3OX3
-A KUBE-SVC-V2OKYYMBY3REGZOG -m comment --comment "default/nginx-service -> 192.167.12.215:80" -m statistic --mode random --probability 0.50000000000 -j KUBE-SEP-JYWXUEKDFJZ6DYLA
-A KUBE-SVC-V2OKYYMBY3REGZOG -m comment --comment "default/nginx-service -> 192.167.5.182:80" -j KUBE-SEP-Y7L7WSSHDLS5RI3K
```

### NodePort Range

As the `NodePort` service uses ports of the nodes to distribute the traffic to pods, how many `NodePort` service can be created? By default, Kubernetes reserves the port range: 30000-32767 determined by `--service-node-port-range` flag.[^1]  This means in a Kubernetes cluster, there can be 2768 `NodePort` services. If all the ports in this range are allocated by `NodePort` service, new `NodePort` service creation would fail with error message `failed to allocate a nodePort: range is full`.

When encountering this issue, users may consider two solutions: expanding the port range for `NodePort` services or reducing the number of unnecessary `NodePort` services. In some scenarios, it is not allowed to change the port range. For example, currently the AWS EKS does not support changing the API server flag. Therefore, the following shows steps to find out how many `NodePort` service exist in that cluster and decides how to reduce the `NodePort` services count in their cluster.

## Troubleshooting: NodePort Range full

### List all the services using NodePort

To identify all `NodePort` services in a Kubernetes cluster, users can execute the following command:

{% raw %}
```bash
$ kubectl get svc --all-namespaces -o go-template='{{range .items}}\{\{ $save := . \}\}{{range.spec.ports}}{{if .nodePort}}{{$save.metadata.namespace}}{{"/"}}{{$save.metadata.name}}{{" - "}}{{.name}}{{": "}}{{.nodePort}}{{"\n"}}{{end}}{{end}}{{end}}'

default/my-service - test1: 30240
default/my-service - test2: 32468
default/my-service - test3: 30118
default/nginx-service - <no value>: 31309
default/sample-service - test-80: 30787
```
{% endraw %}

Here we can see, the `sample-service` here is actually a `LoadBalancer` type service:

```bash
$ kubectl get svc sample-service
NAME             TYPE           CLUSTER-IP     EXTERNAL-IP                                                                    PORT(S)        AGE
sample-service   LoadBalancer   10.100.80.78   k8s-default-example.com   80:30787/TCP   79d
```

Why a `LoadBalancer` service also consume a `NodePort`?

### LoadBalancer service consume NodePort

By default, the  `LoadBalancer` service consume a `NodePort` so the load balancer would distribute the network traffic to the `NodePort` of node IP address and the traffic will be distributed to the pods by iptables as what demonstrated earlier. Under certain situation, we can disabled the `NodePort` allocation for `LoadBalancer` service. The Kubernetes document states:[^2]

> You can optionally disable node port allocation for a Service of `type: LoadBalancer`, by setting the field `spec.allocateLoadBalancerNodePorts` to `false`. This should only be used for load balancer implementations that route traffic directly to pods as opposed to using node ports.

For example, with AWS VPC CNI plugin, every pod gets its own IP address from the VPC IP range[^3] and NLB supports IP-type target.[^4] This means NLB can distribute the network traffic to the Pod port by the Pod IP address directly and we can disable the `NodePort` allocation for such situation to reduce the unnecessary `NodePort` allocation to reduce the `NodePort` allocation count.

However, we might face a situation with NLB when we have confirmed lower `NodePort` service count and no `NodePort` allocation for `LoadBalancer` service, and still face the error `failed to allocate a nodePort: range is full`. What else is consuming the `NodePort` allocation in the cluster?

### NLB helathcheck port

Sometimes people might figure the NLB service with `externaltrafficpolicy` as `Local` to avoid unnecessary network traffic goes through among nodes if they don't use NLB IP target type(See why it is not recommended to use `externaltrafficpolicy: Local` on EKS[^5]). In this case of `externaltrafficpolicy: Local` and if they did not specified healthcheck port with annotation `service.beta.kubernetes.io/aws-load-balancer-healthcheck-port` . According to the AWS Load Balancer Controller document, the NLB service will use another `healthcheck nodeport`:[^6]

> if you do not specify the health check port, the default value will be spec.healthCheckNodePort when externalTrafficPolicy=local or traffic-port otherwise.

According to the Kubernetes document, healthcheck nodeport will consume the `NodepPort` range too:[^7]

> .spec.healthCheckNodePort - specifies the health check node port (numeric port number) for the service. If you don't specify healthCheckNodePort, the service controller allocates a port from your cluster's NodePort range.

In this case, people can use `externaltrafficpolicy: Local` with specified healthcheck port by annotation `service.beta.kubernetes.io/aws-load-balancer-healthcheck-port` to solve the extra `NodePort` allocation by `LoadBalancer` service. For NLB service, people can also use IP target type and disable `NodePort` allocation by setting `spec.allocateLoadBalancerNodePorts` to `false` reduce the `NodePort` consuming issue.

## Summary

This article goes through what a `NodePort` service is and `NodePort` range full issue with `LoadBalancer` service and a scenario involving NLB with `externaltrafficpolicy: Local` without specifying the health check port. By understanding and addressing these factors, users can effectively troubleshoot and manage `NodePort` allocation issues in their Kubernetes environments.

## References

[^1]: [Kubernetes 1.27: Avoid Collisions Assigning Ports to NodePort Services - Kubernetes](https://kubernetes.io/blog/2023/05/11/nodeport-dynamic-and-static-allocation)
[^2]: [Disabling load balancer NodePort allocation](https://kubernetes.io/docs/concepts/services-networking/service/#load-balancer-nodeport-allocation)
[^3]: [amazon-vpc-cni-k8s/docs/cni-proposal.md at master · aws/amazon-vpc-cni-k8s · GitHub](https://github.com/aws/amazon-vpc-cni-k8s/blob/master/docs/cni-proposal.md#proposal)
[^4]: [Target groups for your Network Load Balancers - Target type](https://docs.aws.amazon.com/elasticloadbalancing/latest/network/load-balancer-target-groups.html#target-type)
[^5]: [\[AWS\]\[EKS\] Best practice for load balancing - 1. Let’s start with an example from Kubernetes document - Continuous Improvement](https://easoncao.com/eks-best-practice-load-balancing-1-en/)
[^6]: [Annotations - AWS Load Balancer Controller](https://kubernetes-sigs.github.io/aws-load-balancer-controller/v2.6/guide/service/annotations/)
[^7]: [Create an External Load Balancer - Kubernetes](https://kubernetes.io/docs/tasks/access-application-cluster/create-external-load-balancer/)
