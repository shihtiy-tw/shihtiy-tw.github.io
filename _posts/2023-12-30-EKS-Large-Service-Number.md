---
title: 'Kubernetes Mysteries Slowness: Why Java Application Bootstrap Lagging'
date: 2023-12-30 09:37:12 +0000
categories: [CSIE, AWS, EKS]
tags: [kubernetes, eks, large-cluster]
---

## Introduction

Sometimes when containers running from the same image show different starting time in different Kubernetes cluster, we would normally first compare the different resources in the clusters like node instance type, node AMI, CPU/Memory/Disk/Networking performance, Kubernetes version, third-party integration etc. However, some factors may not be that intuitive in this kind of use case in Kubernetes. This article demonstrate a situation that same spring container shows different starting time in two different EKS cluster while there was no resources performance issue.

## Scenario

We observed that a same Java spring container always has higher starting time in cluster A while it is constantly faster starting time in cluster B:

- Java spring container start time in cluster A:

```
2023-12-18 18:30:57.200 INFO 83 --- [ main] com.example.demo.Application : Started Application in 3.182 seconds (JVM running for 3.793)
```

- Java spring container start time in cluster B:

```
2023-12-18 19:30:53.800 INFO 83 --- [ main] com.example.demo.Application : Started Application in 4.597 seconds (JVM running for 5.334)
```

After we went through and checked the resources difference between these two cluster like node type, node number, CPU/Memory/Disk/Networking performance etc, Kubernetes version etc, there is no much difference would cause this significant difference for application start time. A only known difference is that the cluster A is the main production cluster.

## Troubleshooting

### Starting the container manually

In a further troubleshooting, we observed that if we run the container manually on the node in cluster A, the long start time issue won't exist and the start time is almost the same as running in cluster B. In this way, we can assert that some kind of Kubernetes mechanism should cause this high application start time issue.

### Number of service environment variables

After digging into the container, we observed that there were more ENV variable in the pod running in cluster A and these ENV variable are of the information of Kubernetes service in cluster A. As described in the Kubernetes document:[^1]

> When a Pod is run on a Node, the kubelet adds a set of environment variables for each active Service. It adds `{SVCNAME}_SERVICE_HOST` and `{SVCNAME}_SERVICE_PORT` variables, where the Service name is upper-cased and dashes are converted to underscores.
> For example, the Service `redis-primary` which exposes TCP port 6379 and has been allocated cluster IP address 10.0.0.11, produces the following environment variables:
>
REDIS_PRIMARY_SERVICE_HOST=10.0.0.11
REDIS_PRIMARY_SERVICE_PORT=6379
REDIS_PRIMARY_PORT=tcp://10.0.0.11:6379
REDIS_PRIMARY_PORT_6379_TCP=tcp://10.0.0.11:6379
REDIS_PRIMARY_PORT_6379_TCP_PROTO=tcp
REDIS_PRIMARY_PORT_6379_TCP_PORT=6379
REDIS_PRIMARY_PORT_6379_TCP_ADDR=10.0.0.11

To determine if the environment variable number is the factor, I decided to increase the service number in a test cluster and see if the spring container start time will increase or not. Here is my test result:

| Cluster | version | node type   | node number | pod number | service number | env number | init time                                                                                     | comments                                                                                                                                                                                                                                                                                                                                        |
| ------- | ------- | ----------- | ----------- | ---------- | -------------- | ---------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| large   | 1.23    | c5.2xlarge  | 50          | 50         | 20             | 158        | 3.871                                                                                         |                                                                                                                                                                                                                                                                                                                                                 |
| large   | 1.23    | c5.2xlarge  | 50          | 50         | 5000           | 34990      | 7.205                                                                                         |                                                                                                                                                                                                                                                                                                                                                 |
| large   | 1.23    | c5.2xlarge  | 50          | 50         | 10000          |            | pod crash                                                                                     | $ kubectl get pods  <br>NAME READY STATUS RESTARTS AGE  <br>java-app-74687d4c7d-28bfj 0/1 CrashLoopBackOff 6 (102s ago) 8m36s  <br>java-app-74687d4c7d-2bwwk 0/1 CrashLoopBackOff 6 (99s ago) 8m36s  <br>  <br>  <br>$ kubectl logs java-app-74687d4c7d-zzn44  <br>standard_init_linux.go:228: exec user process caused: argument list too long |
| large   | 1.23    | c6i.8xlarge | 50          | 50         | 10000          |            | pod crash  <br>(standard_init_linux.go:228: exec user process caused: argument list too long) | resources:  <br>requests:  <br>memory: 8Gi  <br>cpu: 4  <br>limits:  <br>memory: 8Gi  <br>cpu: 4                                                                                                                                                                                                                                                |
| large   | 1.23    | c6i.8xlarge | 50          | 50         | 10000          |            | pod crash  <br>(standard_init_linux.go:228: exec user process caused: argument list too long) | resources:  <br>requests:  <br>memory: 16Gi  <br>cpu: 8  <br>limits:  <br>memory: 16Gi  <br>cpu: 8                                                                                                                                                                                                                                              |
| large   | 1.23    | c5.2xlarge  | 50          | 50         | 10000          |            | 2.85                                                                                          | set enableServiceLinks as false in the pod spec                                                                                                                                                                                                                                                                                                 |

Here we can see the spring container start time did increase as the environment number increase. At certain point, the pod would crash with the logs `(standard_init_linux.go:228: exec user process caused: argument list too long)`.

## Solution

Based on the error message `(standard_init_linux.go:228: exec user process caused: argument list too long)`, I did find some existing issue discussing the high Kubernetes service environment variable causing their pods crash[^2] [^3]. I also found a flag `enableServiceLinks` which can disable the injection of Kubernetes service environment variables into the pods.[^4] :

```yaml
    spec:
      enableServiceLinks: false
      containers:
        - name: java-app
          image: java
```

Here we can see even with 10000 service in my test cluster, the pod can still run successfully and the starting time was not that high anymore:

| Cluster | version | node type  | node number | pod number | service number | env number | init time | comments                                        |
| ------- | ------- | ---------- | ----------- | ---------- | -------------- | ---------- | --------- | ----------------------------------------------- |
| large   | 1.23    | c5.2xlarge | 50          | 50         | 10000          |            | 2.85      | set enableServiceLinks as false in the pod spec |

From the Kubernetes documents we read that it is recommended to disabled the Kubernetes service environment if the environment variables are not desired or if the environment variable cause problem like what we observed:[^5]

> If the service environment variables are not desired (because possible clashing with expected program ones, too many variables to process, only using DNS, etc) you can disable this mode by setting the `enableServiceLinks` flag to `false` on the [pod spec](https://kubernetes.io/docs/reference/generated/kubernetes-api/v1.29/#pod-v1-core).

In the EKS best practice[^6] it also wrote the upper limit is 5000 services per namespace：

> When a Pod runs on a Node, the kubelet adds a set of environment variables for each active Service. Linux processes have a maximum size for their environment which can be reached if you have too many services in your namespace. The number of services per namespace should not exceed 5,000. After this, the number of service environment variables outgrows shell limits, causing Pods to crash on startup.

In an awesome talk "Kubernetes Scalability: A Multi-Dimensional Analysis"[^7] , the speaker further explained and described the scalability limitation in the dimension of number of service in a namespace:

> The limit on the x-axis of 5,000 services per namespace and the reason for this is that in Kubernetes whenever you create a pod in a namespace as part of the downstream API you populate the pod with a bunch of environmental variables for every single service that has been created in that namespace and when you go beyond a threshold which is 5,000 the part starts to crash because the kernel cannot load the process into memory because there's just not enough space in the buffer for the process which holds environment variables.

## Summary

We can see that the Kubernetes injected the service environment variable is a expected behaviour. When the service number per namespace exceed 5000, it may impact the process performance and even cause the pod crash. This behaviour can be disabled by setting `enableServiceLinks` as false if the service discovery via environment variable is not required.

## References

[^1]: [Discovering services](https://kubernetes.io/docs/concepts/services-networking/service/#discovering-services)
[^2]: [Add warning to help users with unclear error \`standard\_init\_linux.go:211: exec user process caused "argument list too long"\` · Issue #84539 · kubernetes/kubernetes](https://github.com/kubernetes/kubernetes/issues/84539)
[^3]: [1000+ services in the same namespace will degrade pod start time & eventually prevent pods from starting · Issue #92615 · kubernetes/kubernetes](https://github.com/kubernetes/kubernetes/issues/92615)
[^4]: [Kubernetes API Reference Docs](https://kubernetes.io/docs/reference/generated/kubernetes-api/v1.29/#pod-v1-core)
[^5]: [Accessing the Service](https://kubernetes.io/docs/tutorials/services/connect-applications-service/#accessing-the-service)
[^6]: [Workloads - EKS Best Practices Guides](https://aws.github.io/aws-eks-best-practices/scalability/docs/workloads/#disable-enableservicelinks-by-default)
[^7]: [Kubernetes Scalability: A Multi-Dimensional Analysis - Shyam Jeedigunta & Maciek Różacki, Google - YouTube](https://youtu.be/t_Ww6ELKl4Q?si=WEVzyOK0lGUjbIcR&t=1104)
