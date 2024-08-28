---
title: "Kubernetes Eviction of Ephemeral Storage: Troubleshoot OOMKilled Pods That Won't Restart"
date: 2024-08-27 23:31:21 +0000
categories:
  - CSIE
  - Kubernetes
tags:
  - kubernetes
  - oom
  - ephemeral-storage
  - eviction
---

## Introduction

According to the Kubernetes documents, when a container in a pod consumes more memory than its limit, the pod is killed. A Pod killed by OOM (`OOMKilled` Pod) will be restarted if the restart policy allow:[^1]

> If the Container continues to consume memory beyond its limit, the Container is terminated. If a terminated Container can be restarted, the kubelet restarts it, as with any other type of runtime failure.

However, sometimes people may see an OOMKilled Pod stuck and the Kubernetes scheduler start another pod without restarting the OOMKilled Pod. This article records a scenario that the `ephemeral-storage` usage of the pod may cause a killed pod not be restarted.

## The Scenario

In most cases,, when a pod is killed by OOM, the pod will be restarted. We can see the behaviour from the following `kubectl get pod` output after executing the example in the Kuberentes document:[^1]

```bash
$ kubectl get pods -w
NAME                            READY   STATUS      RESTARTS     AGE
oom-demo-766c8d556d-2vm85       0/1     OOMKilled          11 (5m10s ago)   31m
oom-demo-766c8d556d-2vm85       0/1     CrashLoopBackOff   11 (15s ago)     31m
oom-demo-766c8d556d-2vm85       0/1     OOMKilled          12 (5m9s ago)    36m
oom-demo-766c8d556d-2vm85       0/1     CrashLoopBackOff   12 (15s ago)     36m
oom-demo-766c8d556d-2vm85       0/1     OOMKilled          13 (5m7s ago)    41m
oom-demo-766c8d556d-2vm85       0/1     CrashLoopBackOff   13 (14s ago)     41m
oom-demo-766c8d556d-2vm85       0/1     OOMKilled          14 (5m5s ago)    46m
```

However, there are situations where an OOMKilled pod may not be restarted, stuck in the `OOMKilled` or `Error` ,and instead, the Kubernetes scheduler will start a new pod:

```bash
$ kubectl get pods -o wide
NAME                          READY   STATUS        RESTARTS       AGE     IP               NODE
oom-demo-6f7747887b-7vx6v     0/1     Error               1               68s     192.167.35.208   ip-192-167-35-2.ec2.internal
oom-demo-6f7747887b-m8bh5     1/1     Running             0               1s      192.167.28.227   ip-192-167-19-202.ec2.internal
```

But why the killed pod is not restarted while the `RestartPolicy` should be `Always` for a deployment[^2] and the pod should be automatically restarts the container after any termination.[^3]

## Explanation

This can happen when the pod is evicted due to reaching the node's ephemeral storage limit. Ephemeral storage is the temporary storage used by a pod for storing logs, data, and other temporary files. Each node has a limit on the amount of ephemeral storage that can be used by pods running on that node. When a pod's ephemeral storage usage exceeds this limit, the pod is evicted from the node.

When a pod is evicted due to exceeding the ephemeral storage limit, the kubelet marks the pod as "Failed" with the reason "Evicted." The scheduler then assumes that the pod cannot be restarted on the same node and starts a new pod instead.

While the killed pod still exist in the cluster, we can check the pod by `kubectl describe pod`:

```bash
$ kubectl describe pod oom-demo-6f7747887b-7vx6v
...
Status:           Failed
Reason:           Evicted
Message:          The node was low on resource: ephemeral-storage. Threshold quantity: 8583014118, available: 554332Ki.
...
  Warning  Evicted              8m18s                  kubelet            The node was low on resource: ephemeral-storage. Threshold quantity: 8583014118, available: 554332Ki.
  Normal   Killing              8m18s                  kubelet            Stopping container memory-demo-2-ctr
  Warning  ExceededGracePeriod  8m8s                   kubelet            Container runtime did not kill the pod within specified grace period.
```

Here we can see that the pod is actually be evicted because the ephemeral-storage is reached the threshold of the node. We can see the ephemeral-storage threshold is `8583014118` bytes (8 GB) when it is a node of 80 GB disk which is `10%` of the node disk size.

If the pod is running on EKS with control plane logging enabled[^4], we can also query the control plane log to see the message:

```
fields @timestamp, verb, requestURI, objectRef.namespace, objectRef.resource, objectRef.name , userAgent, requestObject.status.message
    | filter verb not in ["get", "list", "watch"]
    | filter objectRef.name  like "oom-demo-6f7747887b-7vx6v" or objectRef.name like "oom-demo-6f7747887b-m8bh5"
```

| @timestamp              | verb   | requestURI                                                        | objectRef.resource | objectRef.name            | userAgent                                                         | requestObject.status.message                                                                          |
| ----------------------- | ------ | ----------------------------------------------------------------- | ------------------ | ------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 2024-08-27 14:51:04.952 | patch  | /api/v1/namespaces/default/pods/oom-demo-6f7747887b-m8bh5/status  | pods               | oom-demo-6f7747887b-m8bh5 | kubelet/v1.29.5 (linux/amd64) kubernetes/1109419                  |                                                                                                       |
| 2024-08-27 14:51:04.951 | create | /api/v1/namespaces/default/pods/oom-demo-6f7747887b-m8bh5/binding | pods               | oom-demo-6f7747887b-m8bh5 | kube-scheduler/v1.29.6 (linux/arm64) kubernetes/c978c80/scheduler |                                                                                                       |
| 2024-08-27 14:51:04.950 | patch  | /api/v1/namespaces/default/pods/oom-demo-6f7747887b-7vx6v/status  | pods               | oom-demo-6f7747887b-7vx6v | kubelet/v1.29.5 (linux/amd64) kubernetes/1109419                  | The node was low on resource: ephemeral-storage. Threshold quantity: 8583014118, available: 554332Ki. |

## Lab

To reproduce this scenario, we can create a deployment with a container to consume a large amount of ephemeral storage and memory.

1. Create a deployment with a stress container:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: oom-demo
spec:
  replicas: 1
  selector:
    matchLabels:
      app: oom-demo
  template:
    metadata:
      labels:
        app: oom-demo
    spec:
      containers:
        - name: memory-demo
          image: polinux/stress
          resources:
            requests:
              memory: "50Mi"
            limits:
              memory: "100Mi"
          command: ["sleep"]
          args: ["3600"]
```

2. To consume the ephemeral storage and cause the pod killed by OOM, in the container, create a large file to consume ephemeral storage and trigger oom by executing `fallocate` and `stress` as following:

```bash
$ kubectl exec -it oom-demo-6f7747887b-7vx6v -- /bin/bash

bash-5.0# df -h; fallocate -l 75G storage.log; df -h; stress --vm 1 --vm-bytes 250M --vm-hang 1
Filesystem                Size      Used Available Use% Mounted on
overlay                  79.9G      4.4G     75.5G   6% /

Filesystem                Size      Used Available Use% Mounted on
overlay                  79.9G     79.4G    549.2M  99% /

stress: info: [16] dispatching hogs: 0 cpu, 0 io, 1 vm, 0 hdd
command terminated with exit code 137
```

At the same time, we can see the pod `oom-demo-6f7747887b-7vx6v` was OOM killed and in this case it was restarted once then entering Error status, without further restarting and a new pod is created:

```
$ kubectl get pods -o wide -w
NAME                                                 READY   STATUS        RESTARTS       AGE     IP               NODE
oom-demo-6f7747887b-7vx6v                            1/1     Running       0              6s      192.167.35.208   ip-192-167-35-2.ec2.internal
oom-demo-6f7747887b-7vx6v                            0/1     OOMKilled     0              29s     192.167.35.208   ip-192-167-35-2.ec2.internal
oom-demo-6f7747887b-7vx6v                            1/1     Running       1 (1s ago)      30s     192.167.35.208   ip-192-167-35-2.ec2.internal
oom-demo-6f7747887b-7vx6v                            0/1     Error         1 (39s ago)     68s     <none>           ip-192-167-35-2.ec2.internal
oom-demo-6f7747887b-m8bh5                            0/1     Pending       0               0s      <none>           <none>
oom-demo-6f7747887b-m8bh5                            0/1     ContainerCreating   0               0s      <none>           ip-192-167-19-202.ec2.internal
oom-demo-6f7747887b-7vx6v                            0/1     Error               1               68s     192.167.35.208   ip-192-167-35-2.ec2.internal
oom-demo-6f7747887b-m8bh5                            1/1     Running             0               1s      192.167.28.227   ip-192-167-19-202.ec2.internal
```

## Summary

In summary, when a Kubernetes pod is evicted due to exceeding the node's ephemeral storage limit, the kubelet marks the pod as "Failed" with the reason "Evicted." The scheduler then assumes that the pod cannot be restarted on the same node and starts a new pod instead of restarting the evicted pod. To prevent this issue and ensure that the node has sufficient ephemeral storage capacity, we can monitor the pod disk usage, rotating the pod log/data or even use extra storage like PV/PVC.

In the past, I thought a pod killed by OOM must be restarted by kubelet continuously. From this scenario I learned that a pod being restarted and triggering eviction would continue existing in the cluster while the scheduler already start a new pod and we need to delete the pod manually.

## References

[^1]: [Exceed a Container's memory limit](https://kubernetes.io/docs/tasks/configure-pod-container/assign-memory-resource/#exceed-a-container-s-memory-limit)
[^2]: [Pod Template](https://kubernetes.io/docs/concepts/workloads/controllers/deployment/#pod-template)
[^3]: [Container restart policy](https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/#restart-policy)
[^4]: [Send control plane logs to CloudWatch Logs](https://docs.aws.amazon.com/eks/latest/userguide/control-plane-logs.html)
