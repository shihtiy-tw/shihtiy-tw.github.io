---
title: 'Who send the DNS Queries: How to Track the Sending Process with SystemTap'
date: 2023-09-20 11:21:41 +0000
categories: [CSIE, Linux]
tags: [linux, systemtap, dns]
---

## Introduction

Sometimes you may wonder which process is responsible for sending the DNS request on your servers. While capturing DNS packets with `tcpdump` is possible, identifying the process ID(PID) from the source port number can be challenging, especially for short-live processes. In this article, we will discuss an interesting troubleshooting scenario and demonstrate how to use SystemTap[^1] to identify the process responsible for sending DNS queries by monitoring system events.

## Scenario

When organisations need to change their DNS resolver due to business requirements, their operation team will update the DNS resolver configuration `/etc/resolv.conf` to point to a new DNS resolver. However, if their old DNS server has logging enabled, they may discover some DNS queries still being sent to their old DNS server. The challenge lies in identifying which process continues to send DNS queries to the old server, despite the `etc/resolv.conf` update.

## Issue Description

Typically, most people would use `tcpdump` to determine which source port the DNS queries are coming from. However, it will be difficult to map the UDP source port to the process that sent the query. With `netstat` it may miss the information during the sampling period.

The following troubleshooting use case will demonstrate how to troubleshooting this scenario by checking the process behaviour with SystemTap and other troubleshooting steps.

## Troubleshooting Scenario

Let's consider a scenario where, in an Hadoop cluster, we observed that some DNS query were still being sent to the old DNS server even after modifying the `/etc/resolv.conf`.

### Process Behaviour When `/etc/resolv.conf` Changed

To understand the process behaviour when this file is changed, I initially used the `strace` command to see how the process acts when `/etc/resolv.conf` file is changed. I noticed that when `/etc/resolv.conf` is modified, the process trigger a system call, `stat`, to examine the `/etc/resolv.conf` file. The `stat` system call retrieves file information[^2]. It seems that the process checks the modification time (mtime) to determine whether it should apply the new resolver configuration:

```bash
$ sudo strace -f -T -tt -p 24685 -o strace.txt
$ sed -i 's/8.8.8.8/1.1.1.1/' /etc/resolv.conf

18:41:14 stat("/etc/resolv.conf",  <unfinished ...>
18:41:14 <... futex resumed> ) = -1 ETIMEDOUT (Connection timed out) <1.000051>
18:41:14 <... stat resumed> {st_mode=S_IFREG|0644, st_size=119, ...}) = 0 <0.000038>
18:41:14 futex(0x56019b4935d8, FUTEX_WAKE_PRIVATE, 1 <unfinished ...>
18:41:14 open("/etc/hosts", O_RDONLY|O_CLOEXEC <unfinished ...>
18:41:14 <... futex resumed> ) = 0 <0.000048>
...
...
18:41:44 stat("/etc/resolv.conf", {st_mode=S_IFREG|0644, st_size=119, ...}) = 0 <0.000037>
18:41:44 open("/etc/resolv.conf", O_RDONLY|O_CLOEXEC) = 579 <0.000033>
18:41:44 fstat(579, {st_mode=S_IFREG|0644, st_size=119, ...}) = 0 <0.000021>
18:41:44 mmap(NULL, 4096, PROT_READ|PROT_WRITE, MAP_PRIVATE|MAP_ANONYMOUS, -1, 0) = 0x7fd190440000 <0.000039>
18:41:44 read(579, "options timeout:2 attempts:5\n; g"..., 4096) = 119 <0.000058>
```

However, despite observing this behaviour, we still encountered DNS queries being sent to the old DNS server. Let's dive deeper into this situation.

### Using SystemTap to Capture the Process ID(PID)

SystemTap monitors the system events by compiling the scripts to kernel modules and loading them to a running Linux kernel[^3]. I discovered an example script that monitors packets sent to destination port 53[^4] and modified it as the following:

```bash
cat << EOF > /tmp/who-sent-it.stp
#! /usr/bin/env stap

# Print a trace of threads sending IP packets (UDP or TCP) to a given
# destination port and/or address.  Default is unfiltered.

global the_dport = 53    # override with -G the_dport=53
global the_daddr = ""   # override with -G the_daddr=127.0.0.1

probe netfilter.ip.local_out {
    if ((the_dport == 0 || the_dport == dport) &&
        (the_daddr == "" || the_daddr == daddr))
            printf("%s %s[%d:%d] sent packet from %s:%d to %s:%d\n", ctime(), execname(), pid(), tid(), saddr, sport, daddr, dport)
}
EOF
```

This script will monitoring the `netfilter.ip.local_out` event which triggers when an outgoing IP packet is sent[^5]. This script targets packets destined for port 53 and prints the following information:

- The timestamp
- The name of the executable that sent the packet
- The PID and TID of the thread that sent the packet
- The source IP address and port of the packet
- The destination IP address and port of the packet

The script's output appears as follows:

```bash
$ stap who_sent_it.stp | grep "172.31.0.2:53"
Tue Jul  5 10:19:19 2023 amazon-ssm-agen[3684:3695] sent packet from 172.31.30.71:60227 to 172.31.0.2:53
Tue Jul  5 10:19:19 2023 amazon-ssm-agen[3684:4714] sent packet from 172.31.30.71:45324 to 172.31.0.2:53
Tue Jul  5 10:19:27 2023 hostname[32652:32652] sent packet from 172.31.30.71:37583 to 172.31.0.2:53
Tue Jul  5 10:19:27 2023 amazon-ssm-agen[3684:4715] sent packet from 172.31.30.71:49583 to 172.31.0.2:53
Tue Jul  5 10:19:27 2023 amazon-ssm-agen[3684:4714] sent packet from 172.31.30.71:43514 to 172.31.0.2:53
```

With `tcpdump`, you can capture packets sent to port 53, but identifying the sending process remains challenging:

```bash
$ sudo tcpdump -n port 53

14:07:28.672844 IP 172.31.25.238.59588 > 8.8.8.8.domain: 10483+ A? ip-172-31-23-99.us-west-2.compute.internal.us-west-2.compute.internal. (87)
14:07:28.672868 IP 172.31.25.238.59588 > 8.8.8.8.domain: 43263+ AAAA? ip-172-31-23-99.us-west-2.compute.internal.us-west-2.compute.internal. (87)
14:07:28.685744 IP 8.8.8.8.domain > 172.31.25.238.59588: 43263 NXDomain 0/1/0 (162)
14:07:28.686253 IP 8.8.8.8.domain > 172.31.25.238.59588: 10483 NXDomain 0/1/0 (162)

```

However, with the SystemTap script, we can now determine the Process ID (PID) responsible for sending DNS queries, enabling us to identify the root cause:

```bash
# stap who_sent_it.stp | grep "8.8.8.8:53"

IPC Server hand[17192:17715] sent packet from 172.31.25.238:59588 to 8.8.8.8:53
IPC Server hand[17192:17715] sent packet from 172.31.25.238:59588 to 8.8.8.8:53

$ sudo ps aux | grep 17192
yarn     17192  0.9  3.3 4608488 533080 ?      Sl   11:50   1:16 /usr/lib/jvm/java-openjdk/bin/java -Dproc_resourcemanager
```

## Summary

With SystemTap script, we successfully identified the service responsible for sending DNS queries to the old DNS server and fix this issue by restarting the service. SystemTap empower us to troubleshoot and narrow down such issue within system. In the future, for such issue it will be worthwhile to experimenting with eBPF.[^6]

## References

[^1]: [SystemTap Beginners Guide Red Hat Enterprise Linux 6 | Red Hat Customer Portal](https://access.redhat.com/documentation/en-us/red_hat_enterprise_linux/6/html-single/systemtap_beginners_guide/index#introduction)
[^2]: [stat(3type) - Linux manual page](https://man7.org/linux/man-pages/man3/stat.3type.html)
[^3]: [stap(1) - Linux manual page](https://man7.org/linux/man-pages/man1/stap.1.html)
[^4]: [sourceware.org/systemtap/examples/network/who\_sent\_it.stp](https://sourceware.org/systemtap/examples/network/who_sent_it.stp)
[^5]: [probe::netfilter.ip.local\_out Red Hat Enterprise Linux 7 | Red Hat Customer Portal](https://access.redhat.com/documentation/en-us/red_hat_enterprise_linux/7/html/systemtap_tapset_reference/api-netfilter-ip-local-out)
[^6]: [A Deep Dive into eBPF: Writing an Efficient DNS Monitoring. | by Nurkholish Halim | Medium](https://medium.com/@nurkholish.halim/a-deep-dive-into-ebpf-writing-an-efficient-dns-monitoring-2c9dea92abdf)
