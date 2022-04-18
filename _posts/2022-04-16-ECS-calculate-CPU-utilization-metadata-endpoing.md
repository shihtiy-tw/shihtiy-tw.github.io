---

title: How to calculate CPU utilization from ECS endpoint?
date: 2022-04-16 23:01:11 +0000
categories: [category1, category2]
tags: [tag1, tag2]
---


#00GTD/writing/01thinking 

## Introduction / Summary

This article will go though how to check and calculate the container CPU utilization from ECS metadata endpoint.

## Scenario

Sometimes people want to know how to calculate the performance usages of the containers. They can use sidecar container to retrieve the data from the metrics provided by the ECS metadata endpoint. Thus they can collect, calculate and export the performance metrics like CPU utilization.

## Explanation

### The CPU metrics provided by ECS metadata endpoint

The [ECS metadata document ](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task-metadata-endpoint-v4.html#task-metadata-endpoint-v4-paths) mentions the following metadata path regarding the resource usage of container/task:

- `${ECS_CONTAINER_METADATA_URI_V4}/stats`: This path returns Docker stats for the specific container.
- `${ECS_CONTAINER_METADATA_URI_V4}/task/stats` : This path returns Docker stats for **all** of the containers associated with the task.

By accessing the endpoint `${ECS_CONTAINER_METADATA_URI_V4}/stats` inside a container, we can see the following output about CPU statistic:

```bash
$ curl ${ECS_CONTAINER_METADATA_URI_V4}/stats | jq '.cpu_stats'
```

```json
{
  "cpu_usage": {
    "total_usage": 6854309182,
    "percpu_usage": [
      3836064097,
      3018245085
    ],
    "usage_in_kernelmode": 3510000000,
    "usage_in_usermode": 2790000000
  },
  "system_cpu_usage": 1139128190000000,
  "online_cpus": 2,
  "throttling_data": {
    "periods": 0,
    "throttled_periods": 0,
    "throttled_time": 0
  }
}
```

We can see another field called `precpu_stats`. The Docker API [ContainerStats](https://docs.docker.com/engine/api/v1.30/#operation/ContainerStats) document mentioned that the `precpu_stats` is the CPU statistic of the _previous_ read, and is used to calculate the CPU usage percentage. `precpu_stats` is different from the `cpu_stats` field.

```bash
$ curl ${ECS_CONTAINER_METADATA_URI_V4}/stats | jq '.precpu_stats'
```

```json
{
  "cpu_usage": {
    "total_usage": 6854629990,
    "percpu_usage": [
      3836187199,
      3018442791
    ],
    "usage_in_kernelmode": 3510000000,
    "usage_in_usermode": 2790000000
  },
  "system_cpu_usage": 1139150390000000,
  "online_cpus": 2,
  "throttling_data": {
    "periods": 0,
    "throttled_periods": 0,
    "throttled_time": 0
  }
}
```


### How to calculate CPU utilization?

As [ECS metadata document ](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task-metadata-endpoint-v4.html#task-metadata-endpoint-v4-paths) mentions that these data are retrieved via Docker API [ContainerStats](https://docs.docker.com/engine/api/v1.30/#operation/ContainerStats) , we can see the Docker API [ContainerStats](https://docs.docker.com/engine/api/v1.30/#operation/ContainerStats) document mention how to calculate the CPU uilization:

-   cpu_delta = `cpu_stats.cpu_usage.total_usage - precpu_stats.cpu_usage.total_usage`
-   system_cpu_delta = `cpu_stats.system_cpu_usage - precpu_stats.system_cpu_usage`
-   number_cpus = `lenght(cpu_stats.cpu_usage.percpu_usage)` or `cpu_stats.online_cpus`
-   CPU usage % = `(cpu_delta / system_cpu_delta) * number_cpus * 100.0`

With the example above, we can then calculate the average CPU utilization:

- cpu_delta = cpu_stats.cpu_usage.total_usage - precpu_stats.cpu_usage.total_usage
    - cpu_delta = 6854309182 - 6854629990
- system_cpu_delta = cpu_stats.system_cpu_usage - precpu_stats.system_cpu_usage
    - system_cpu_delta = 1139128190000000 - 1139150390000000
- number_cpus = lenght(cpu_stats.cpu_usage.percpu_usage) or cpu_stats.online_cpus
    - number_cpus = 2
- CPU usage % = (cpu_delta / system_cpu_delta) * number_cpus * 100.0
    - CPU usage % = (6854309182 - 6854629990) / (1139128190000000 - 1139150390000000) * 2 * 100

### Is `system_cpu_usage` considered as "shared" or "separated" for the containers ?

Some people are wondering if the `system_cpu_usage` is the same for each container stat output or the metrics is different for each container. For this question, we can check the related code, I can see that the `system_cpu_usage` is system-level:

1. Find the `system_cpu_usage`:  [code](https://github.com/moby/moby/blob/7b9275c0da707b030e62c96b679a976f31f929d3/api/types/stats.go)

```go
// System Usage. Linux only.

SystemUsage uint64 `json:"system_cpu_usage,omitempty"`
```

2. Find that `getSystemCPUUsage` will return the CPU usage: [code](https://github.com/moby/moby/blob/2773f81aa5e9e34733675a7aa7e4219391caccb0/daemon/stats/collector.go#L121)

```go
// Sample system CPU usage close to container usage to avoid
// noise in metric calculations.
systemUsage, err := s.getSystemCPUUsage()
if err != nil {
  logrus.WithError(err).WithField("container_id", pair.container.ID).Errorf("collecting system cpu usage")
  continue
}
```

3. Confirm the system CPU usage is retrieved from `/proc/stat`: [code](https://github.com/moby/moby/blob/2773f81aa5e9e34733675a7aa7e4219391caccb0/daemon/stats/collector_unix.go#L31)

```go
func (s *Collector) getSystemCPUUsage() (uint64, error) {
	f, err := os.Open("/proc/stat")
...
...
```

4. `/proc/stat` is kernel/system-wise static: [proc(5) - Linux manual page](https://man7.org/linux/man-pages/man5/proc.5.html)

```bash
[root@ip-172-31-83-85 ~]# cat /proc/stat
cpu  1858672 145 937683 147711096 42100 0 8871 790 0 0
cpu0 948377 51 470796 73832328 20560 0 5919 200 0 0
cpu1 910294 94 466886 73878768 21539 0 2951 589 0 0
```

5. Confirm that `system_cpu_usage` is the same for both containers in the same task by accessing `${ECS_CONTAINER_METADATA_URI_V4}/task/stats`:

```bash
$ curl ${ECS_CONTAINER_METADATA_URI_V4}/task/stats

  "5f71e2b846442b1cc146d399135f490fdbbb5f3936b38119ffcf3c5d85308ac5": {
    "cpu_stats": {
...
      "system_cpu_usage": 1478570440000000,
...
  "b0f919cbff4c787ae765cbcc8b094d4375bdb002848d78e9e635356bd94d8484": {
    "cpu_stats": {
...
      "system_cpu_usage": 1478570450000000,
...
```

We can see `system_cpu_usage` is the system-level metrics and this metric will be the same for both containers.

## Summary

ECS metadata endpoint provides metrics of container resources so people have the flexibility to collect, calculate the container performance by their own application or other third-party application like datadog.

We can also see that if we want to know deeper about the metrics, we can dig into the code and find the metrics resources to get more insight about the metrics.