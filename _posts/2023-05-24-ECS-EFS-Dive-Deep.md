---
title: 'Deep Dive into AWS ECS: How ECS awsvpc Network Mode Works with EFS'
date: 2023-05-24 17:28:00 +0000
categories: [CSIE, AWS]
tags: [aws, ecs, efs, namespace, dnsmasq, awsvpc]
---

## Introduction

Amazon ECS has being supporting Amazon Elastic File System(EFS) over the years.[^1] AWS provides resources including tutorials and several Knowledge Center articles and video[^4] to guide customers on mounting EFS with ECS on both EC2[^2] and Fargate platforms[^3].

In addition to configuring ECS to work with EFS, customers often express interest in understanding the underlying mechanisms how ECS operates with EFS, particularly in awsvpc network mode. This article will deep dive to how ECS with awsvpc mode works with EFS and provide a detailed troubleshooting case study, focusing on mounting EFS with dnsmasq in the awsvpc network mode.

## EFS and awsvpc network mode

EFS is a storage service supporting Network File System(NFS) protocol. It allows multiple clients to mount the EFS file system and concurrently access its data via network. In awsvpc mode, ECS will provision a extra ENI for each ECS task and a unique network namespace for the containers within that ECS task[^5]. With this setup, the network traffic from the ECS task to EFS transits through its own ENI. But how does ECS with awsvpc mode manage to route this traffic to EFS?

## How does ECS with awsvpc network mode mount EFS?

To dig into this, I will first probe the current ECS agent repository[^7] and examine the mechanism based on existing resources.

### Tracing the ecs-init and ECS agent code

In the ecs-init repository, I can see a EFS mount helper file[^6]. Next, in the ECS agent code, we can see that, with awsvpc mode, the ECS agent retrieves the network namespace by examining the pause container involved in the task with the awsvpc mode. The ECS agent will then pass the network namespace value as a mount option so that the mount takes place in the task network namespace mode([source code](https://github.com/aws/amazon-ecs-agent/blob/883211e24d9255023a68f6351001c291af8a699b/agent/taskresource/volume/dockervolume.go#L339)):

```go
func (vol *VolumeResource) getDriverOpts() map[string]string {
	opts := vol.VolumeConfig.DriverOpts
	if vol.VolumeConfig.Driver != ECSVolumePlugin {
		return opts
	}
	// For awsvpc network mode, pause pid will be set (during the step when the pause container transitions to
	// RESOURCE_PROVISIONED), and if the driver is the ecs volume plugin, we will pass the network namespace handle
	// to the driver so that the mount will happen in the task network namespace.
	pausePID := vol.GetPauseContainerPID()
	if pausePID != "" {
		mntOpt := NewVolumeMountOptionsFromString(opts["o"])
		mntOpt.AddOption("netns", fmt.Sprintf(netNSFormat, pausePID))
		opts["o"] = mntOpt.String()
	}
	return opts
}
```


This indicates the format of the network namespace information here([source code](https://github.com/aws/amazon-ecs-agent/blob/883211e24d9255023a68f6351001c291af8a699b/agent/taskresource/volume/dockervolume.go#L43)):

```go
netNSFormat               = "/proc/%s/ns/net"
```

While continuing to trace the code, I can see that the mount opt is passed along the volume create function code ([source code - docker volume Create](https://github.com/aws/amazon-ecs-agent/blob/883211e24d9255023a68f6351001c291af8a699b/agent/taskresource/volume/dockervolume.go#LL318C1-L338C1), [source code - docker client](https://github.com/aws/amazon-ecs-agent/blob/883211e24d9255023a68f6351001c291af8a699b/agent/dockerclient/dockerapi/docker_client.go#L1195), [source code - docker go client](https://github.com/aws/amazon-ecs-agent/blob/883211e24d9255023a68f6351001c291af8a699b/agent/dockerclient/dockerapi/docker_client.go#L1225)) and then reaches the docker volume create API ( [source code - volume create](https://github.com/aws/amazon-ecs-agent/blob/883211e24d9255023a68f6351001c291af8a699b/agent/vendor/github.com/docker/docker/client/volume_create.go#L12)):

```go
func (cli *Client) VolumeCreate(ctx context.Context, options volumetypes.VolumeCreateBody) (types.Volume, error) {
	var volume types.Volume
	resp, err := cli.post(ctx, "/volumes/create", nil, options, nil)
...
...
```

I further check the Docker API document. However, it does not explain the usage of the option of network namespace.[^8]

### Examining the mechanism based on existing EFS volume for ECS

To understand how the ECS agent creates an EFS volume, I go ahead and inspect an existing EFS volume:

```bash
$ sudo docker volume ls
DRIVER                     VOLUME NAME
amazon-ecs-volume-plugin   ecs-service-4-service-storage-eceaddbc8aa6efd5c001

$ sudo docker volume inspect ecs-service-4-service-storage-eceaddbc8aa6efd5c001
[
    {
        "CreatedAt": "2023-05-24T21:32:19Z",
        "Driver": "amazon-ecs-volume-plugin",
        "Labels": {},
        "Mountpoint": "/var/lib/ecs/volumes/ecs-service-4-service-storage-eceaddbc8aa6efd5c001",
        "Name": "ecs-service-4-service-storage-eceaddbc8aa6efd5c001",
        "Options": {
            "device": "fs-xxx:/",
            "o": "netns=/proc/5865/ns/net",
            "type": "efs"
        },
        "Scope": "local"
    }
]
```
{: .nolineno }

This shows how the ECS agent uses the network namespace of the pause container during the mounting process:

```bash
$ ps -p 5865
  PID TTY          TIME CMD
 5865 ?        00:00:00 pause
```
{: .nolineno }

From the Docker volume information, I can replicate the EFS volume creation using similar mount options:

```bash
$ sudo docker volume create \
>    --driver amazon-ecs-volume-plugin \
>    --opt device=fs-xxx:/ \
>    --opt o=netns=/proc/5865/ns/net \
>    --opt type=efs
6b70649b4bd84f9597c7e44276f05043a4d2a45c6a79ca33598440bd4d533b87
```
{: .nolineno }

Next, I can observe that the newly created EFS volume is mounted in the OS:

```bash
$ mount | grep fs-
fs-xxx.efs.us-east-1.amazonaws.com:/ on /var/lib/ecs/volumes/ecs-service-4-service-storage-eceaddbc8aa6efd5c001 type nfs4 (rw,relatime,vers=4.1,rsize=1048576,wsize=1048576,namlen=255,hard,noresvport,proto=tcp,timeo=600,retrans=2,sec=sys,clientaddr=10.0.1.38,local_lock=none,addr=10.0.1.111)
```
{: .nolineno }

Interestingly, there is no observable TCP connection with EFS in the host network namespace:

```bash
$ sudo netstat -antop
# No connection with the EFS port 10.0.1.111:2049
```
{: .nolineno }

The TCP connection, in fact, resides within the network namespace of the pause container associated with the ECS task utilizing the EFS volume:

```bash
# Enter the network namespace
$ sudo nsenter -t 5865 -n /bin/bash

[root@ip-10-0-101-226 ssm-user]# sudo netstat -antop
Active Internet connections (servers and established)
Proto Recv-Q Send-Q Local Address           Foreign Address         State       PID/Program name     Timer
tcp        0      0 10.0.1.38:38326         10.0.1.111:2049         ESTABLISHED -                    keepalive (1.87/0/0)
```
{: .nolineno }

## Case Study: dnsmasq on ECS of awsvpc mode with EFS

### Problem description

Now lets explore an interesting use case: customer sometimes install dnsmasq and will observe that the ECS task of awsvpc fail to start due to DNS resolve error with EFS domain name:

```txt
Error response from daemon: create 90c64341c8c681d53476d69dd8e8c1fe9a180ac367b282a155d00f259a800849: VolumeDriver.Create: mounting volume failed: b'mount.nfs4: Failed to resolve server fs-xxx.efs.us-east-1.amazonaws.com: Name or service not known\nmount.nfs4: Operation already in progress'
```

However, the same DNS error will not happen with bridge mode and host mode. At the same time, there is no issue to resolve EFS domain name and to mount the EFS.

Let's dive deep on how to troubleshoot this issue.

### Troubleshooting steps

#### 1. The role of DNS resolver configuration in EFS volume creation

The DNS resolver configuration file `/etc/resolv.conf` plays a key role here. When configuring the `/etc/resolv.conf` with the VPC DNS resolver, the EFS volume can be created successfully:

```bash
$ cat /etc/resolv.conf
options timeout:2 attempts:5
; generated by /usr/sbin/dhclient-script
search ec2.internal
nameserver 169.254.169.253

$ sudo docker volume create \
>    --driver amazon-ecs-volume-plugin \
>    --opt device=fs-xxx:/ \
>    --opt o=netns=/proc/5865/ns/net \
>    --opt type=efs
6b70649b4bd84f9597c7e44276f05043a4d2a45c6a79ca33598440bd4d533b87
```
{: .nolineno }

As soon as I modified `/etc/resolv.conf` to use `127.0.0.1` as the resolver (in this case, dnsmasq) for further test. I cannot create docker volume of EFS in that network namespace of ECS task:

```bash
$ cat /etc/resolv.conf
options timeout:2 attempts:5
; generated by /usr/sbin/dhclient-script
search ec2.internal
nameserver 127.0.0.1

$ sudo docker volume create \
>    --driver amazon-ecs-volume-plugin \
>    --opt device=fs-xxx:/ \
>    --opt o=netns=/proc/5865/ns/net \
>    --opt type=efs

Error response from daemon: create 90c64341c8c681d53476d69dd8e8c1fe9a180ac367b282a155d00f259a800849: VolumeDriver.Create: mounting volume failed: b'mount.nfs4: Failed to resolve server fs-xxx.efs.us-east-1.amazonaws.com: Name or service not known\nmount.nfs4: Operation already in progress'
```
{: .nolineno }

At the same time, I can still create docker volume without specifying the network namespace of the ECS task and resolve EFS DNS as well:

```
$ docker volume create \
>   --driver amazon-ecs-volume-plugin \
>   --opt device=fs-xxx:/ \
>   --opt type=efs
2530acaacb7618260ba45c901981607ee61d6595c6c5fecaa73cec1ff258939b

$ dig +short fs-xxx.efs.us-east-1.amazonaws.com
10.0.1.111
```
{: .nolineno }

#### 2. Investigating the network namespace of ECS task.

As explained above, the way how ECS agent mount EFS is under the network namespace of the ECS task. Because a network namespace isolates the networking environment of a process, the dnsmasq listening socket of the container instance won't be present in this ECS task's network namespace:

```bash
$ sudo nsenter --net=/proc/5865/ns/net

# netstat -aop
Active Internet connections (servers and established)
Proto Recv-Q Send-Q Local Address           Foreign Address         State       PID/Program name     Timer
tcp        0      0 10.0.1.38:38326         10.0.1.111:2049         ESTABLISHED -                    keepalive (1.87/0/0)
```

As we only use the network namespace of the ECS task and no mount namespace is used, the process continues to rely on 127.0.0.1 (dnsmasq in this case) for DNS resolution. Because dnsmasq does not have listening socket in this network namespace, thus we cannot resolve the EFS domain name here:

```bash
# cat /etc/resolv.conf
options timeout:2 attempts:5
; generated by /usr/sbin/dhclient-script
search ec2.internal
nameserver 127.0.0.1

# dig fs-0705b30dbe1741990.efs.us-east-1.amazonaws.com

; <<>> DiG 9.11.4-P2-RedHat-9.11.4-26.P2.amzn2.5.2 <<>> fs-0705b30dbe1741990.efs.us-east-1.amazonaws.com
;; global options: +cmd
;; connection timed out; no servers could be reached
```
{: .nolineno }

### Summary

The reason why DNS resolving issue occur for EFS with ECS task of awsvpc mode is because the ECS agent attempts to mount EFS under the network namespace of the ECS task, where the dnsmasq does not have a listening socket in that network namespace.

This issue can be mitigated by adding the VPC DNS resolver `169.254.169.253` in `/etc/resolv.conf` after `127.0.0.1` which is dnsmasq. As the algorithm used by DNS resolving with `/etc/resolv.conf` is to try a name server, and if the DNS query times out, try the next until out of the name servers. Then, the DNS query will repeat trying all the name servers until a maximum number of retries are made[^9]:

```bash
$ cat /etc/resolv.conf
options timeout:2 attempts:5
; generated by /usr/sbin/dhclient-script
search ec2.internal
nameserver 127.0.0.1 #dnsmasq
nameserver 169.254.169.253
```
{: .nolineno }

The ECS task of awsvpc mode with EFS can still start successfully, after the fist resolver timeout. However, the downside of this method is that the ECS task launch time will suffer the first resolver to timeout and increase the overall launch time of the ECS task.

Another way is to create another group of container instances without dnsmasq and use ECS task placement constraints[^10] to place ECS task with awsvpc mode on these container instances. If you will launch many ECS task of awsvpc mode with EFS and does not want to suffer the timeout for first resolver, the customer can consider this method to avoid this DNS resolving issue.

## References

[^1]: [Amazon Elastic Container Service & AWS Fargate, now support Amazon Elastic File System - AWS News Blog](https://aws.amazon.com/blogs/aws/amazon-ecs-supports-efs/)
[^2]: [Mount an EFS file system on an ECS container or task - AWS re:Post](https://repost.aws/knowledge-center/efs-mount-on-ecs-container-or-task)
[^3]: [Mount Amazon EFS file systems on Amazon ECS containers or tasks on Fargate - AWS re:Post](https://repost.aws/knowledge-center/ecs-fargate-mount-efs-containers-tasks)
[^4]: [How do I mount an Amazon EFS file system on an Amazon ECS container or task running on Fargate? - YouTube](https://www.youtube.com/watch?v=JANKxp728dg&ab_channel=AmazonWebServices)
[^5]: [Under the Hood: Task Networking for Amazon ECS - AWS Compute Blog](https://aws.amazon.com/blogs/compute/under-the-hood-task-networking-for-amazon-ecs/)
[^6]: [amazon-ecs-init/efs\_mount\_helper.go - aws/amazon-ecs-init](https://github.com/aws/amazon-ecs-init/blob/589067c48f0de67d074bc15347db09eae472693f/ecs-init/volumes/efs_mount_helper.go#L25)
[^7]: [aws/amazon-ecs-agent: Amazon Elastic Container Service Agent](https://github.com/aws/amazon-ecs-agent)
[^8]: [Docker Engine API v1.42 Reference](https://docs.docker.com/engine/api/v1.42/#tag/Volume/operation/VolumeCreate)
[^9]: [resolv.conf(5) - Linux manual page](https://man7.org/linux/man-pages/man5/resolv.conf.5.html)
[^10]: [Amazon ECS task placement constraints - Amazon Elastic Container Service](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task-placement-constraints.html)
