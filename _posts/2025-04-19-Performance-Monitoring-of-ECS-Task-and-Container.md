---
aliases:
  - Performance Monitoring of ECS Task and Container
append_modified_update: true
title: "Amazon ECS Performance Observability: A Guide to Monitoring Tasks and Containers with CloudWatch ContainerInsight"
date: 2025-04-19 14:45:12 +0000
categories:
  - CSIE
  - AWS
  - ECS
tags:
  - aws
  - container
  - ecs
  - cloudwatch
  - containerinsight
  - monitoring
  - observability
modified:
  - 2025-04-19T17:01:53+01:00
date created: Saturday, April 19th 2025, 1:44:31 pm
date modified: Saturday, April 19th 2025, 3:44:18 pm
---

## Introduction

Monitoring Amazon ECS tasks and containers is critical for diagnosing performance bottlenecks, optimizing resource usage, and ensuring application reliability. Common methods, like deploying sidecar containers, often add complexity and overhead. Amazon CloudWatch Container Insights simplifies this process by offering a fully managed solution to collect and visualize task- and container-level metrics. 

In this article, we will use Amazon CloudWatch Container Insights and Amazon CloudWatch metric filters to collect and visualize the task-level and container-level performance metrics. By applying this method, you can gain a more straightforward understanding of ECS task and container performance.

> Currently ContainerInsight has a feature: [enhanced observability](https://aws.amazon.com/blogs/aws/container-insights-with-enhanced-observability-now-available-in-amazon-ecs/) to visualize the task/container-level monitoring. You can either use enhanced observability for account-level or cluster-level resources, or use the method in this article to monitor certain ECS service/task based on their business.
{: .prompt-info }

## Setup the Metric Filter 

Once we enable CloudWatch Container Insight, the Amazon ECS container agent or AWS Fargate will start to send container logs and metrics to [Amazon CloudWatch](https://aws.amazon.com/cloudwatch/). Then, we can design the [metric filters](https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/MonitoringLogData.html) based on your needs to observe Amazon ECS task and container-level performance. The potential scenarios include checking a single task’s performance when there is an imbalanced workload on the Amazon ECS service or distinguish which container is exhausting memory, disk, CPU, or network resources in an ECS task with multiple containers.

In this approach, there are two major steps that need to be completed:

1. Set up the metric filter for task-level metrics.
2. Set up the metric filter for container-level metrics.

> **Note**: The table below summarizes the metric filter configurations for monitoring ECS task and container performance.
{: .prompt-info }

| Metric Name              | Filter Name               | Metric Value     | Dimensions                         |
|--------------------------|---------------------------|------------------|------------------------------------|
| Task CpuUtilized         | Task Utilized CPU         | $.CpuUtilized    | ClusterName, ServiceName, TaskId   |
| Task MemoryUtilized      | Task Utilized Memory      | $.MemoryUtilized | ClusterName, ServiceName, TaskId   |
| Container CpuUtilized    | Container Utilized CPU    | $.CpuUtilized    | ServiceName, TaskId, ContainerName |
| Container MemoryUtilized | Container Utilized Memory | $.MemoryUtilized | ServiceName, TaskId, ContainerName |


### Task-level Metrics

1. Go to the log group of CloudWatch Container Insights performance log in [CloudWatch Logs](https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/Working-with-log-groups-and-streams.html#ViewingLogData). The log group name format is `/aws/ecs/containerinsights/<Your ECS Cluster Name>/performance`.


    ![Picture 1.png](/assets/img/posts/2025-04-19-Performance-Monitoring-of-ECS-Task-and-Container/Picture-1.png)

2. Create [a metric filter](https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/CreateMetricFilterProcedure.html) for the log group of CloudWatch Container Insights performance logs. For **Filter pattern**, enter a [filter pattern](https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/FilterAndPatternSyntax.html) for task-level performance log of an ECS service name.

    ```
    { $.ServiceName = "Your-ECS-Service-Name" && $.Type = "Task" }
    ```

    In this example figure, the ECS service name is "nginx-fargate-service".

    ![Picture 2.png](/assets/img/posts/2025-04-19-Performance-Monitoring-of-ECS-Task-and-Container/Picture-2.png)


    > You can change [the filter pattern syntax](https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/FilterAndPatternSyntax.html) to match the naming of your ECS services. The metric filter quota is [100 per log group](https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/cloudwatch_limits_cwl.html) and cannot be increased. See also the [billing consideration](https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/FilterAndPatternSyntaxForMetricFilters.html#logs-metric-filters-dimensions).
    {: .prompt-info }

3. Next, define the metrics on CloudWatch metrics:
    1. For **Filter name**, enter **Task Utilized CPU**.
    2. For **Metric namespace**, enter **ECS Performance** with Create new enabled.
    3. For **Metric name**, enter **Task CpuUtilized**.
    4. For **Metric value**, enter **$.CpuUtilized**.
    5. For **Dimensions**, enter the following:
        1. Name: **ClusterName**, Value: **$.ClusterName**.
        2. Name: **ServiceName**, Value: **$.ServiceName**.
        3. Name: **TaskId**, Value: **$.TaskId**.

    ![Picture 3.png](/assets/img/posts/2025-04-19-Performance-Monitoring-of-ECS-Task-and-Container/Picture-3.png)

    You can see now the overview of the metric filter creation.

    ![Picture 4.png](/assets/img/posts/2025-04-19-Performance-Monitoring-of-ECS-Task-and-Container/Picture-4.png)

    After creating the metric filter, on the CloudWatch Logs console you can see the created filter.

    ![Picture 5.png](/assets/img/posts/2025-04-19-Performance-Monitoring-of-ECS-Task-and-Container/Picture-5.png)

4. Click on the Metric name “ECS/Performance / Task CpuUtilized”, you can see the metrics of each ECS task CPU usage:

    ![Picture 6.png](/assets/img/posts/2025-04-19-Performance-Monitoring-of-ECS-Task-and-Container/Picture-6.png)

5. Using the same concept for task memory metrics, create another metric filter with the same steps for the metric filter of CPU. Create the same filter pattern `{ $.ServiceName = "nginx-fargate-service" && $.Type = "Task" }` and filter the form as the following, modify the **Metric value** as **$.MemoryUtilized**.

    ![Picture 7.png](/assets/img/posts/2025-04-19-Performance-Monitoring-of-ECS-Task-and-Container/Picture-7.png)
    ![Picture 8.png](/assets/img/posts/2025-04-19-Performance-Monitoring-of-ECS-Task-and-Container/Picture-8.png)

    After creating the metrics filter for task memory you should see the created filter:

    ![Picture 9.png](/assets/img/posts/2025-04-19-Performance-Monitoring-of-ECS-Task-and-Container/Picture-9.png)

### Container-level Metrics

1. The steps to setup container-level metrics are similar to the steps we tool for task-level metrics. Go to the same log group of CloudWatch Container Insights performance log in [CloudWatch Logs](https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/Working-with-log-groups-and-streams.html#ViewingLogData).

    ![Picture 10.png](/assets/img/posts/2025-04-19-Performance-Monitoring-of-ECS-Task-and-Container/Picture-10.png)


2. Create another metric filter for the log group of CloudWatch Container Insights performance logs. For **Filter pattern**, enter a [filter pattern](https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/FilterAndPatternSyntax.html) for container-level performance log of an ECS service name.

    `{ $.ServiceName = "Your-ECS-Service-Name" && $.Type = "Container" }`

    In this example figure, the ECS service name is again the "nginx-fargate-service":

    ![Picture 11.png](/assets/img/posts/2025-04-19-Performance-Monitoring-of-ECS-Task-and-Container/Picture-11.png)

3. Next, define the metrics on CloudWatch metrics:
    1. For Filter name, enter Container Utilized CPU.
    2. For Metric namespace, choose the ECS Performance created previously without Create new enabled.
    3. For Metric name, enter Container CpuUtilized.
    4. For Metric value, enter $.CpuUtilized.
    5. For Dimensions, enter the following:
        1. Name: ServiceName, Value: $.ServiceName.
        2. Name: TaskId, Value: $.TaskId.
        3. Name: ContainerName, Value: $.ContainerName.
        
    ![Picture 12.png](/assets/img/posts/2025-04-19-Performance-Monitoring-of-ECS-Task-and-Container/Picture-12.png)

    > Since the metrics filter only support 3 dimensions, we did not include the cluster name here. You can change the dimensions based on your operation practice.
    {: .prompt-info }

4. Next, you can see the overview of the metric filter creation and create the metrics filter.

    ![Picture 13.png](/assets/img/posts/2025-04-19-Performance-Monitoring-of-ECS-Task-and-Container/Picture-13.png)

    Using the same concept, create another metric filter with the same steps for the metric filter of CPU. Create the same filter pattern `{ $.ServiceName = "nginx-fargate-service" && $.Type = "Container" }` and filter the form as the following, modify the **Metric value** as **$.MemoryUtilized**.

> If you extract metrics from log events, you will be [charged for custom metrics](https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/FilterAndPatternSyntaxForMetricFilters.html#logs-metric-filters-dimensions). You can follow the steps in [Deleting a metric filter topic](https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/DeletingMetricFilter.html) to delete the metric filters created earlier.
  {: .prompt-warning }


## Use cases

Now, when we set up metric filters for task- and container-level metrics, let’s review use cases where we can use those metrics.

### Monitor Task CPU and Memory.

We have an ECS task with task-level CPU limit of 2048 [CPU units](https://repost.aws/knowledge-center/ecs-cpu-allocation) (2 vCPU) and memory limit of 2048 MBi. Then we execute a single thread command (like while true; do :; done) to consume 1024 CPU units. We can see the task-level CPU and memory metrics on the CloudWatch metrics:

![Picture 14.png](/assets/img/posts/2025-04-19-Performance-Monitoring-of-ECS-Task-and-Container/Picture-14.png)

In one of [AWS blog posts](https://aws.amazon.com/blogs/mt/introducing-container-insights-for-amazon-ecs/), it wrote how to use CloudWatch Container Insights performance metrics to query the raw data:

```
fields @message
| filter Type="Task"
| filter @logStream like /FargateTelemetry/
| stats  latest(ClusterName) as Cluster, max(CpuReserved) as MaxCpuReserved, avg(CpuUtilized) as AvgCpuUtilized, max(CpuUtilized) as PeakCpuUtilized, ceil(avg(MemoryUtilized)) as AvgMemUtilized, max(MemoryUtilized) as PeakMemUtilized by TaskId
| sort TaskId asc
```
{: .nolineno }

We used this method to verify the CloudWatch metrics match to the CloudWatchContainer Insights performance log for the ECS task:

![Picture 15.png](/assets/img/posts/2025-04-19-Performance-Monitoring-of-ECS-Task-and-Container/Picture-15.png)

### Monitor Container Memory.

When there are multiple containers in an ECS task, we need to dive into container-level metrics to understand which container consumes the resources. Let’s take another example of an ECS task with 3 different containers. We used the [stress command](https://linux.die.net/man/1/stress) to allocate 1.5 GB memory usage constantly in the container.

```bash
stress --vm 1 --vm-bytes 1536M --vm-keep
```
{: .nolineno }

From a task-level memory metric, we can see the memory usage consumed by the ECS task:

![Picture 16.png](/assets/img/posts/2025-04-19-Performance-Monitoring-of-ECS-Task-and-Container/Picture-16.png)

When checking the container-level memory metric, we can clearly see that it is the stress container that consumes high memory usage:

![Picture 17.png](/assets/img/posts/2025-04-19-Performance-Monitoring-of-ECS-Task-and-Container/Picture-17.png)

## Conclusion

This article shows how you can use Amazon CloudWatch Container Insights to gain comprehensive visibility into the performance of your Amazon ECS workloads. By setting up metric filters to collect task-level and container-level performance metrics, you can easily identify resource-intensive tasks and containers, allowing you to optimize resource utilization and troubleshoot issues more effectively.
