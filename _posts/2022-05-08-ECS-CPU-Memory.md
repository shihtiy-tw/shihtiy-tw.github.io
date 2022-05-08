---

title: '[AWS][ECS] What I learned about CPU and memory management of Amazon ECS'
date: 2022-05-08 00:06:00 +0000
categories: [CSIE, Cloud, AWS]
tags: [aws, ecs, memory, cpu]
---

## Introduction

This article will go through what I learned from [How Amazon ECS manages CPU and memory resources](https://aws.amazon.com/blogs/containers/how-amazon-ecs-manages-cpu-and-memory-resources/) and few things I add about the CPU and memory management of Amazon ECS.

## Two General Rules

The blog[^1] mentioned that there are two general rules of thumb with containers:

- unless otherwise restricted and capped, a container gets access to all the CPU and memory capacity available on a given host (operating system).
- unless otherwise protected and guaranteed, all containers share CPU, memory, and other resources on a given host (operating system) in the same way that other processes running on that host share those resources.

And we are going to talk about how the task and container access and share the CPU and memory resources with the related configuration defined in a task definition.

## Memory

For memory management, ECS provides the configuration of two levels:
- container-level: `memoryReservation` (soft limit) and `memory` (hard limit) 
- task-level: `memory` (hard limit)

Let's discuss what the differences, how these settings affect task scheduling and some scenarios of these different memory setting.

### Container-level: memoryReservation(soft limit) and memory(hard limit) 

#### memoryReservation(soft limit)

[The task definition document about memory setting](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task_definition_parameters.html#container_definition_memory) mentioned that `memoryReservation` is a soft limit (in MiB):

- This option indicates the memory size that a task needs on a container instance when being placed. 
- The sum of the `memoryReservation` of all containers in all the tasks running on a container instance, cannot exceed the available memory on that container instance.

#### memory(hard limit)

[The task definition document about memory setting](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task_definition_parameters.html#container_definition_memory) mentioned `memory` is the hard limit (in MiB) of the container:

- `memory` is the upper bound that the memory usage a container cannot go beyond.
- If the container exceed the `memory`, the container will be killed (by out-of-memory(OOM) killer of the Linux kernel which we will discuss later). 

#### Notes for memoryReservation(soft limit) and memory(hard limit)

For the available memory of a container instance:

- If you specify `memoryReservation`, the available memory of a container instance will be subtracted by `memoryReservation`.
- If you do not specify `memoryReservation`, the available memory of a container instance will be subtracted by `memory`.

See below tables for the reservation and ceiling of the memory size a container can use:

| Configuration                           | Reservation         | Ceiling                                                                             |
| --------------------------------------- | ------------------- | ----------------------------------------------------------------------------------- |
| `memoryReservation` only                | `memoryReservation` | total memory of the container instance or task memory size if configured            |
| `memoryReservation` **and** `memory`<br>(`memory` must be greater than `memoryReservation`)   | `memoryReservation` | `memory`                                                                            |
| `memory` only                           | `memory`            | `memory`                                                                            |
| no `memoryReservation` **nor** `memory` | none                | task-level memory size (and task-level memory size has to be configured, see below note) | 

note: If a task-level memory size is not specified, you must specify a non-zero integer for one or both of `memory` or `memoryReservation` in a container definition. 

### Out-Of-Memory(OOM) killer
If a container exceed the `memory`(hard limit), the container will be killed by Out-Of-Memory(OOM) killer. OOM killer is a Linux kernel mechanism to make sure that the system still have enough memory to run.[^2]

How the OOM killer choose the container to kill will not be discussed in this article. Nevertheless, the blog[^1] does mention below:

> If something is above its soft limit, it’s more likely to be killed than something below its soft limit, but figuring out which process gets killed requires knowing all the other processes on the system and what they are doing with their memory as well.

As we have discussed that the ceiling or hard limit can be the container-level `memory`, task-level memory size or the total memory of the container instance, the mechanisms behind these limits are different.

When the system has low memory and the OOM killer is triggered, we can see the below OOM messages from system logs:

```
[11111111.111111] Out of memory: Kill process 11111 (java) score 311 or sacrifice child
```

On the other hand, the container-level and task-level limit is implemented by Linux control groups(cgroup)[^3] with which we can control the resources a process can utilised. If a container exceed the memory hard limit, we can see cgroup oom from the system logs:

```
[2222222.222222] Memory cgroup out of memory: Kill process 22222 (nginx) score 0 or sacrifice child
```

The OOM usually results in the container to be stopped with exited code 137.

We can take different actions based on if it is an OS-level OOM or a cgroup oom:

- For OS-level OOM, we can
    - distribute the loading on different instances (like task placement)
    - configure task-level or container-level memory limit(hard limit)
- For cgroup OOM, we can
    - increase the task-level or container-level memory limit(hard limit)
    - scale out the container to distribute the loading on more containers

### Swap space

To decreased the impact of low-memory issue, Linux has a mechanism called swap space to allow OS to swap the physical memory to disk to free up memory space to use.

Docker also provide the option to allow container to use swap[^4] and ECS introduce the parameter to configure swap space for each container[^5]. In this way, even the container may hit the hard limit, the container can use swap space to avoid triggering OOM killer.

The blog[^1] mention below:

> While swap config allows the container to swap if configured properly, it does not include accounting for swap usage in the scheduling phase; swap is not treated as a resource for the ECS scheduler.
> ...
> While the OOM behavior isn’t changing, now containers can be configured to swap out to disk in a memory pressure scenario. This can potentially alleviate the need for the OOM killer to kick in (if containers are configured to swap).

### Task-level: memory limit (hard limit)

We already mentioned that we can configure the task memory size and if the total memory usage of the containers within the task exceed the task memory size, OOM killer will be triggered.

When configuring the container-level and task-level memory, we will have the following notices as mentioned by the blog[^1] :

- none of the containers can have a memory hard limit that exceeds the memory size of the task
- the sum of all hard limits can exceed task-level memory size
- the sum of all soft limits cannot exceed task-level memory size

### Scenarios for different memory configurations

With the information above, let's assume the following situations happen in your environment.

- The task size for memory is 512MB.
- Container memory configuration:

| Container | Hard limit |
|:---------:|:----------:|
|     A     |   300 MB   |
|     B     |   300 MB   |

notes: If the `essential` parameter of a container is marked as `true`, and that container fails or stops for any reason, all other containers that are part of the task are stopped.[^6]

#### Scenario 1:

- Container A reach hard limit
- Container A is the essential container
- The total memory usage for container A and B do not reach the task size for memory.

The container A will be killed by OOM, and the task will be stopped.

#### Scenario 2

- Container B reach hard limit
- Container B is not the essential container
- The total memory usage for container A and B do not reach the task size for memory.

The container B will be killed by OOM, and the task will not be stopped.

#### Scenario 3:

- Container A and B does not reach hard limit
- The task size for memory usage has been reached.

It may result in container A or B to be stopped by OOM, depending on which process in container A or B has the highest OOM score.

Of course, if the stopped container is an essential container, the task will be stopped correspondingly.


## CPU

ECS also provide different levels of CPU usage: container-level and task-level. And the mechanism is different from how the memory limit works.

### vCPU and CPU unit

ECS introduce an abstract term call CPU unit. The blog[^1] mentions below:

> “CPU units” is just an ECS construct and it doesn’t exist in the world of the Linux kernel.... As a baseline ECS considers each vCPU available to an EC2 container instance as 1024 units. That is, an EC2 host that has 8 vCPUs has 8×1024=8192 units available.

### Container-level: a relative share

The container-level CPU limit acts as a relative share or weight: Take the example from the blog[^1] :

A task running on a host with 8192 CPU units has two containers: 
- containerA: assigned with 512 units
- containerB: assigned with 1024 units

When both containers are busy and under high loading, they can access the rest CPU time (8192-512-1024=6656 CPU units).  The rest of CPU time will be shared as:

- containerA can get access to 1/3 of 6656 = 2219 CPU units
- containerB can get access to 2/3 of 6656= 4437 CPU units

The blog[^1]  describe the following regarding CPU usages:

- if containers are not using their allotted CPU units, other containers can use that capacity. When capacity is not used, any container can burst to use that spare capacity.
- CPU shares control the amount of CPU capacity available when there is CPU contention; that is, multiple containers attempting to use the CPU at the same time.

notes: When you don’t specify any CPU units for a container, ECS intrinsically enforces two Linux CPU shares(which we will discuss later below) for the cgroup (which is the minimum allowed).

### Task-level: hard limit

The task-level CPU setting is different from container-level CPU setting. The task-level CPU setting is an upper bound of the CPU limit the containers can use.

If the container exceeds the task-level CPU limit, the container will not be killed like a container will be killed by OOM when exceeding memory hard limit.

### Scenarios for different CPU configurations

We can do the following test on a container with 2 vCPUs with and without task-level and different container-level CPU limit to see how it will turn out.

#### Scenario 1: Without task-level CPU limit

There are two containers with the container-level setting: 256 CPU units and 512 CPU units. We can see that the total CPU utilisation is two vCPU and the CPU shared is based on the ratio of the container-level CPU setting:

```bash
$ docker stats
CONTAINER ID        NAME                                                        CPU %               MEM USAGE / LIMIT     MEM %               NET I/O             BLOCK I/O           PIDS
5cdf7ea5edf7        ecs-agent                                                   0.06%               14.91MiB / 7.544GiB   0.19%               0B / 0B             0B / 0B             13
391f208f0606        ecs-stressWithoutTaskCpu-5-stress256-848ebdebcea0ebe8aa01   66.57%              956KiB / 7.544GiB     0.01%               836B / 0B           0B / 0B             3
c73331a916f3        ecs-stressWithoutTaskCpu-5-stress512-86bbd0e094d6e6cdb801   131.23%             880KiB / 7.544GiB     0.01%               836B / 0B           0B / 0B             3
```

#### Scenario 2: With task-level CPU setting: 1024 CPU units

There are two containers with the container-level setting: 256 CPU units and 512 CPU units. We can see that the total CPU utilisation is one vCPU and the CPU shared is based on the ratio of the container-level CPU setting:

```bash
$ docker stats
CONTAINER ID        NAME                                                     CPU %               MEM USAGE / LIMIT     MEM %               NET I/O             BLOCK I/O           PIDS
5cdf7ea5edf7        ecs-agent                                                0.00%               14.92MiB / 7.544GiB   0.19%               0B / 0B             0B / 0B             13
20bc598752c7        ecs-stressWithTaskCpu-2-stress512-98b3befeffe68196de01   67.19%              832KiB / 7.544GiB     0.01%               906B / 0B           0B / 0B             3
487ef173aca2        ecs-stressWithTaskCpu-2-stress256-bafab0898b96d5d3b701   33.52%              924KiB / 7.544GiB     0.01%               816B / 0B           0B / 0B             3
```

## Under the hood

### Memory

As the container resource limit is implemented by cgroup, we can actually check the memory limit from host-level and check the cgroup configuration.

#### cgroup setting for memory

From the cgroup document[^7], we can see that the following files regarding memory limit:

`memory.soft_limit_in_bytes`: set/show soft limit of memory usage
`memory.limit_in_bytes`: set/show limit of memory usage

Let's have a ECS task `602081644df34fb5bf1c5786ef261fe7` which is configured to have 1024 MiB task-level memory setting and the container-level has 128MiB soft limit. We can find these memory limit from cgroup settings. 

#### Task-level memory limit

We can find a directory of cgroup match the task ID and we can see that the `memory.limit_in_bytes` is around 1024 MiB:

```bash
$ cat /sys/fs/cgroup/memory/ecs/602081644df34fb5bf1c5786ef261fe7/memory.limit_in_bytes
1073741824
```

#### Container-level memory limit

Under the directory of cgroup for the ECS task, we will find another directory the and directory name will match the container ID of the ECS task. We can further check the `memory.soft_limit_in_bytes` and see that the value is around 128 MiB. Since I didn't set the container-level hard limit, we can see `memory.limit_in_bytes` is a very huge number:

```bash
# soft limit 128 MB
$ cat /sys/fs/cgroup/memory/ecs/602081644df34fb5bf1c5786ef261fe7/2624b365b6ea72e9c9a9825038136f30c9721665c0e6394fabf29c6960edb593/memory.soft_limit_in_bytes
134217728

$ cat /sys/fs/cgroup/memory/ecs/602081644df34fb5bf1c5786ef261fe7/2624b365b6ea72e9c9a9825038136f30c9721665c0e6394fabf29c6960edb593/memory.limit_in_bytes
9223372036854771712
```

### CPU

#### cgroup setting for CPU

cgroup setting for CPU has different concept from memory. RedHat document gives a detail description about the cgroup setting for CPU[^8]:

- `cpu.shares` contains an integer value that specifies a ==relative share== of CPU time available to the tasks in a cgroup. 

> For example, tasks in two cgroups that have `cpu.shares` set to `100` will receive equal CPU time, but tasks in a cgroup that has `cpu.shares` set to `200` receive twice the CPU time of tasks in a cgroup where `cpu.shares` is set to `100`. The value specified in the `cpu.shares` file must be `2` or higher.

- `cpu.cfs_period_us` specifies a period of time in microseconds (`µs`, represented here as "us") for how regularly a cgroup's access to CPU resources should be reallocated. 
- `cpu.cfs_quota_us` specifies the total amount of time in microseconds (µs, represented here as "us") for which all tasks in a cgroup can run during one period (as defined by cpu.cfs_period_us).
- `nr_throttled`: number of times tasks in a cgroup have been throttled (that is, not allowed to run because they have exhausted all of the available time as specified by their quota).
- `throttled_time`: the total time duration (in nanoseconds) for which tasks in a cgroup have been throttled.

#### Container-level limit

Let's have a container without any container-level CPU setting:

```bash
$ ls -l /sys/fs/cgroup/cpu/ecs/4ed351a8c26d47f0bb502c7019256bc7/5934355a9835e1ea5a70333ffbfeab6767ae046cdf05748b8083640f675f46db/
total 0
-rw-r--r-- 1 root root 0 May  3 21:39 cgroup.clone_children
-rw-r--r-- 1 root root 0 May  3 21:39 cgroup.procs
-r--r--r-- 1 root root 0 May  3 21:39 cpuacct.stat
-rw-r--r-- 1 root root 0 May  3 21:39 cpuacct.usage
-r--r--r-- 1 root root 0 May  3 21:39 cpuacct.usage_all
-r--r--r-- 1 root root 0 May  3 21:39 cpuacct.usage_percpu
-r--r--r-- 1 root root 0 May  3 21:39 cpuacct.usage_percpu_sys
-r--r--r-- 1 root root 0 May  3 21:39 cpuacct.usage_percpu_user
-r--r--r-- 1 root root 0 May  3 21:39 cpuacct.usage_sys
-r--r--r-- 1 root root 0 May  3 21:39 cpuacct.usage_user
-rw-r--r-- 1 root root 0 May  3 21:39 cpu.cfs_period_us
-rw-r--r-- 1 root root 0 May  3 21:39 cpu.cfs_quota_us
-rw-r--r-- 1 root root 0 May  3 21:39 cpu.rt_period_us
-rw-r--r-- 1 root root 0 May  3 21:39 cpu.rt_runtime_us
-rw-r--r-- 1 root root 0 May  3 21:39 cpu.shares
-r--r--r-- 1 root root 0 May  3 21:39 cpu.stat
-rw-r--r-- 1 root root 0 May  3 21:39 notify_on_release
-rw-r--r-- 1 root root 0 May  3 21:39 tasks

```

We can see that the cpu.shares is the default value 2:

```
$ cat /sys/fs/cgroup/cpu/ecs/4ed351a8c26d47f0bb502c7019256bc7/5934355a9835e1ea5a70333ffbfeab6767ae046cdf05748b8083640f675f46db/cpu.shares
2

```

`cpu.cfs_period_us` 100000 and `cpu.cfs_quota_us` -1  means that the container can access the CPU every 1 second and there is no restriction on accessing CPU[^9]. Since there is no hard-limit, there is no throttling happening:

```
$ cat /sys/fs/cgroup/cpu/ecs/4ed351a8c26d47f0bb502c7019256bc7/5934355a9835e1ea5a70333ffbfeab6767ae046cdf05748b8083640f675f46db/cpu.cfs_period_us
100000

$ cat /sys/fs/cgroup/cpu/ecs/4ed351a8c26d47f0bb502c7019256bc7/5934355a9835e1ea5a70333ffbfeab6767ae046cdf05748b8083640f675f46db/cpu.cfs_quota_us
-1

$ cat /sys/fs/cgroup/cpu/ecs/4ed351a8c26d47f0bb502c7019256bc7/5934355a9835e1ea5a70333ffbfeab6767ae046cdf05748b8083640f675f46db/cpu.stat
nr_periods 0
nr_throttled 0
throttled_time 0
```

#### Task-level limit

For example, I have an ECS task `a3d6aa8e76e540a0b48e9ac162c75adb` with task-level CPU setting 512 CPU units, I can check the CPU limit in the following path:

```bash
$ aws ecs list-tasks --cluster ECS-Test | grep 4ed
        "arn:aws:ecs:us-east-1:111111111111:task/ECS-Test/4ed351a8c26d47f0bb502c7019256bc7",

$ docker ps
CONTAINER ID   IMAGE                            COMMAND              CREATED       STATUS                 PORTS                                     NAMES
5934355a9835   httpd                            "httpd-foreground"   13 days ago   Up 13 days             0.0.0.0:49153->80/tcp, :::49153->80/tcp   ecs-apache-20-apache-a0d8c096ccc599997e00

$ ls -l /sys/fs/cgroup/cpu/ecs
total 0
drwxr-xr-x 3 root root 0 Apr 19 22:33 4ed351a8c26d47f0bb502c7019256bc7

$ ls -l /sys/fs/cgroup/cpu/ecs/4ed351a8c26d47f0bb502c7019256bc7/
total 0
drwxr-xr-x 2 root root 0 Apr 19 22:33 5934355a9835e1ea5a70333ffbfeab6767ae046cdf05748b8083640f675f46db
-rw-r--r-- 1 root root 0 May  3 21:39 cgroup.clone_children
-rw-r--r-- 1 root root 0 May  3 21:39 cgroup.procs
-r--r--r-- 1 root root 0 May  3 21:39 cpuacct.stat
-rw-r--r-- 1 root root 0 May  3 21:39 cpuacct.usage
-r--r--r-- 1 root root 0 May  3 21:39 cpuacct.usage_all
-r--r--r-- 1 root root 0 May  3 21:39 cpuacct.usage_percpu
-r--r--r-- 1 root root 0 May  3 21:39 cpuacct.usage_percpu_sys
-r--r--r-- 1 root root 0 May  3 21:39 cpuacct.usage_percpu_user
-r--r--r-- 1 root root 0 May  3 21:39 cpuacct.usage_sys
-r--r--r-- 1 root root 0 May  3 21:39 cpuacct.usage_user
-rw-r--r-- 1 root root 0 Apr 19 22:33 cpu.cfs_period_us
-rw-r--r-- 1 root root 0 Apr 19 22:33 cpu.cfs_quota_us
-rw-r--r-- 1 root root 0 May  3 21:39 cpu.rt_period_us
-rw-r--r-- 1 root root 0 May  3 21:39 cpu.rt_runtime_us
-rw-r--r-- 1 root root 0 May  3 21:39 cpu.shares
-r--r--r-- 1 root root 0 May  3 21:39 cpu.stat
-rw-r--r-- 1 root root 0 May  3 21:39 notify_on_release
-rw-r--r-- 1 root root 0 May  3 21:39 tasks
```

`cpu.cfs_period_us` 100000 and `cpu.cfs_quota_us` 50000 means that the container can access the CPU for 0.5 second for every 1 second.

```
$ cat /sys/fs/cgroup/cpu/ecs/4ed351a8c26d47f0bb502c7019256bc7/cpu.cfs_period_us
100000
$ cat /sys/fs/cgroup/cpu/ecs/4ed351a8c26d47f0bb502c7019256bc7/cpu.cfs_quota_us
50000
```

We can also see that the container has metrics indicating that throttling happened:

```bash
$ cat /sys/fs/cgroup/cpu/ecs/4ed351a8c26d47f0bb502c7019256bc7/cpu.stat
nr_periods 140596
nr_throttled 7
throttled_time 388807946
```

## Summary

The AWS blog[^1] does explain in detail about the memory and CPU management of Amazon ECS and I just organized in a way I understand the blog. Hope this article can give you a brief understanding about how  Amazon ECS design and implement the management of memory and CPU management.

## References

[^1]:  [How Amazon ECS manages CPU and memory resources](https://aws.amazon.com/blogs/containers/how-amazon-ecs-manages-cpu-and-memory-resources/)
[^2]: [Out Of Memory Management](https://www.kernel.org/doc/gorman/html/understand/understand016.html)
[^3]: [cgroups(7) - Linux manual page](https://man7.org/linux/man-pages/man7/cgroups.7.html)
[^4]: [Runtime options with Memory, CPUs, and GPUs](https://docs.docker.com/config/containers/resource_constraints/#--memory-swap-details)
[^5]: [Amazon ECS Now Supports Per-Container Swap Space Parameters](https://aws.amazon.com/about-aws/whats-new/2019/08/amazon-ecs-now-supports-per-container-swap-space-parameters/)
[^6]: [Task definition parameters - Amazon Elastic Container Service](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task_definition_parameters.html)
[^7]: [https://www.kernel.org/doc/Documentation/cgroup-v1/memory.txt](https://www.kernel.org/doc/Documentation/cgroup-v1/memory.txt)
[^8]: [3.2. cpu Red Hat Enterprise Linux 6](https://access.redhat.com/documentation/en-us/red_hat_enterprise_linux/6/html/resource_management_guide/sec-cpu)
[^9]: [https://www.kernel.org/doc/Documentation/scheduler/sched-bwc.txt](https://www.kernel.org/doc/Documentation/scheduler/sched-bwc.txt)