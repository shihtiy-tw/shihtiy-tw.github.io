---

title: '[AWS][ECS] Difference between `storage_stats` and `blkio_stats` from ECS metadata endpoint'
date: 2022-04-19 00:19:33 +0000
categories: [CSIE, Cloud, AWS]
tags: [ECS, Windows]
---

## Introduction / Summary

This article will go though a brief explanation that why  `storage_stats` and `blkio_stats` have different output from ECS metadata endpoint.

## Scenario
Some people will question that why the field `storage_stats` is empty from ECS task metadata while `blkio_stats` has metrics. People expect that the field `storage_stats` should provide some metrics about storage.

## Explanation

As ECS agent get the metrics from docker [ContainerStats](https://docs.docker.com/engine/api/v1.30/#operation/ContainerStats) API, we can further check the metrics from moby repository.

From the following code, we can see that `storage_stats` is for Windows and `blkio_stats` is for Linux.

[moby code: ](https://github.com/moby/moby/blob/7b9275c0da707b030e62c96b679a976f31f929d3/api/types/stats.go)

```go
// Linux specific stats, not populated on Windows.
PidsStats  PidsStats  `json:"pids_stats,omitempty"`
BlkioStats BlkioStats `json:"blkio_stats,omitempty"`

// Windows specific stats, not populated on Linux.
NumProcs     uint32       `json:"num_procs"`
StorageStats StorageStats `json:"storage_stats,omitempty"`
```

[moby code:](https://github.com/moby/moby/blob/7b9275c0da707b030e62c96b679a976f31f929d3/api/types/stats.go)

```go
// StorageStats is the disk I/O stats for read/write on Windows.
type StorageStats struct {
	ReadCountNormalized  uint64 `json:"read_count_normalized,omitempty"`
	ReadSizeBytes        uint64 `json:"read_size_bytes,omitempty"`
	WriteCountNormalized uint64 `json:"write_count_normalized,omitempty"`
	WriteSizeBytes       uint64 `json:"write_size_bytes,omitempty"`
}
```

## Lab

### ECS task on Windows

As I only saw that `storage_stats` is for Windows from the code comments, I need to confirm this behaviour. Therefore, I launched an ECS task on Windows and accessed the ECS metadata endpoint from host level. We can see that `storage_stats` has value and `blkio_stats` has no value: 

```
# on windows
Invoke-WebRequest -uri "http://169.254.170.2/v4/2239d0bc-e1b9-48e0-9d03-f44a30935f9f/stats" -UseBasicParsing | Select-Object -Expand Content

{
  "read": "2022-03-03T15:06:37.9523371Z",
  "preread": "2022-03-03T15:06:36.9398213Z",
  "pids_stats": {},
  "blkio_stats": {
    "io_service_bytes_recursive": null,
    "io_serviced_recursive": null,
    "io_queue_recursive": null,
    "io_service _time_recursive": null,
    "io_wait_time_recursive": null,
    "io_merged_recursive": null,
    "io_time_recursive": null,
    "sectors_recursive": null
  },
  "num_procs": 4,
  "storage_stats": {
    "read_count_normalized": 46167,
    "read_size_bytes": 32.0026112,
    "write_count_normalized": 2982,
    "write_size_bytes": 22934016
  },
...
```

While an output from ECS metadata endpoint for ECS task on Linux may be like the following that the `storage_stats` is empty and `blkio_stats` has value:

```bash
$ curl ${ECS_CONTAINER_METADATA_URI_V4}/task/stats
"blkio_stats": {
            "io_service_bytes_recursive": [
                {
                    "major": 259,
                    "minor": 0,
                    "op": "Read",
                    "value": 0
                },
                {
                    "major": 259,
                    "minor": 0,
                    "op": "Write",
                    "value": 20992
                },
...
        "num_procs": 0,
        "storage_stats": {},
        
```

### AWS Document for ECS task on Windows

We can also see that `storage_stats` has metrics in the test stats for windows from [ECS agent GitHub repository](https://github.com/aws/amazon-ecs-agent/blob/225bc3a556bd2d1759ab27b23f54e7e68086c9f0/agent/stats/windows_test_stats.json):

```json
{
    "blkio_stats": {
        "io_service_bytes_recursive": null,
        "io_serviced_recursive": null,
        "io_queue_recursive": null,
        "io_service_time_recursive": null,
        "io_wait_time_recursive": null,
        "io_merged_recursive": null,
        "io_time_recursive": null,
        "sectors_recursive": null
    },
    "num_procs": 8,
    "storage_stats": {
        "read_count_normalized": 1,
        "read_size_bytes": 3,
        "write_count_normalized": 1,
        "write_size_bytes": 15
    },
```

## Summary

As people may use other monitoring tool like datadog to access ECS metadata point to get resource usage metrics and question why the field is empty[^1], we can see that it is expected to see the field `storage_stats` to be empty if the container is not on Windows. 

## References

[^1]: [`storage_stats` is empty · Issue #2935 · aws/amazon-ecs-agent](https://github.com/aws/amazon-ecs-agent/issues/2935)