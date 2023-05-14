---

title: '[AWS][EC2] Why DHCP Lease Expiration can Cause Instance Status Check Failure?'
date: 2023-05-13 23:26:11 +0000
categories: [CSIE, Cloud, AWS]
tags: [ec2, linux, system-time, instance-status-check, dhcp]
---

## Introduction / Summary

Sometimes customer will report that their EC2 instances fail the instance status check for no reason and it will be healthy again after rebooting the instance. Where there are many reason can lead to instance status check failure, this article will dive deep on why DHCP lease expiration will cause EC2 instances fail the instance status check due to system time change, dhclient issue and network interface configuration.

## Explanation

Let's go through what is DHCP and how DHCP works, what value we can check in DHCP lease and the IP lifetime on the network interface.

### What is DHCP and how does DHCP work?

[The Dynamic Host Configuration Protocol (DHCP)](https://en.wikipedia.org/wiki/Dynamic_Host_Configuration_Protocol) is a network management protocol used on Internet Protocol networks whereby a DHCP server dynamically assigns an IP address and other network configuration parameters to each device on a network so they can communicate with other IP networks.

In RFC 2131, it defines the DHCP client-server interaction to allocate a network address with the following steps:

![DHCP](https://www.researchgate.net/profile/Ruben-Rios-2/publication/259117702/figure/fig1/AS:614197792632833@1523447573381/Message-exchange-models-in-DHCP.png)[^1]

1. _Discovery_: The DHCP client broadcasts a `DHCPDISCOVER` message on the network subnet using the destination address 255.255.255.255.
2. _Offer_: When a DHCP server receives a `DHCPDISCOVER` message from a client, which is an IP address lease request, the DHCP server reserves an IP address for the client and makes a lease offer by sending a `DHCPOFFER` message to the client.
3. _Request_: In response to the DHCP offer, the client replies with a `DHCPREQUEST` message, broadcast to the server, requesting the offered address.
4. _Acknowledgement_: When the DHCP server receives the `DHCPREQUEST` message from the client, the configuration process enters its final phase. The acknowledgement phase involves sending a DHCPACK `packet` to the client.

One thing to notice here is that when the DHCP client get the address offered by DHCP server, it is a network address with a finite lease which requires to renew regularly. Therefore, the DHCP client will do the `DHCPRequest` for lease renewal. We can see the dhclient's DHCP lease renewal behaviour in the system log:

```bash
$ sudo egrep "(Switching root|RTC.*localtime|DHCPREQUEST|DHCPACK|bound to|System clock|Time has been changed)" /var/log/messages | nl

Jun 24 09:04:05 ip-172-31-36-147 dhclient[963]: DHCPREQUEST on ens3 to 172.31.32.1 port 67 (xid=0x534f3961)
Jun 24 09:04:05 ip-172-31-36-147 dhclient[963]: DHCPACK from 172.31.32.1 (xid=0x534f3961)
Jun 24 09:04:07 ip-172-31-36-147 dhclient[963]: bound to 172.31.36.147 -- renewal in 1666 seconds.
```
{: .nolineno }

> The address offered by DHCP server is a network address with a finite lease which requires to renew regularly.
{: .prompt-info }

We can also check the DHCP lease information:

```bash
$ cat /var/lib/dhclient/dhclient--eth0.lease
lease {
  interface "eth0";
  fixed-address 172.31.84.251;
  option subnet-mask 255.255.240.0;
  option routers 172.31.80.1;
  option dhcp-lease-time 3600;
  option dhcp-message-type 5;
  option domain-name-servers 172.31.0.2;
  option dhcp-server-identifier 172.31.80.1;
  option interface-mtu 9001;
  option broadcast-address 172.31.95.255;
  option host-name "ip-172-31-84-251";
  option domain-name "ec2.internal";
  renew  6 2023/05/13 09:02:55; # <------------------------------- will be discussed
  rebind 6 2023/05/13 09:28:04; # <------------------------------- will be discussed
  expire 6 2023/05/13 09:35:34; # <------------------------------- will be discussed
}
```
{: .nolineno }

> I will focus on time-related DHCP lease parameters in this article: **renew, rebind** and **expire**
{: .prompt-info }

### Renew, rebind and expire time

In [RFC 2131 4.4.5 Reacquisition and expiration](https://datatracker.ietf.org/doc/html/rfc2131#section-4.4.5), it define two time points T1 and T2:

> The client maintains two times, T1 and T2, that specify the times at which the client tries to extend its lease on its network address. T1 is the time at which the client enters the RENEWING state and attempts to contact the server that originally issued the client's network address. T2 is the time at which the client enters the REBINDING state and attempts to contact any server. T1 MUST be earlier than T2, which, in turn, MUST be earlier than the time at which the client's lease will expire.
> If the lease expires before the client receives a DHCPACK, the client moves to INIT state, MUST immediately stop any other network processing and requests network initialization parameters as if the client were uninitialized.

We can compare the definition of T1 and T2 between the time parameter in DHCP lease and get that:

- T1 is the renew time.
  - For renew time, DHCP client will communicate with the DHCP server who offered the IP address directly.
- T2 is the rebind time.
  - For rebind time, DHCP client will broadcast if any DHCP server can extend the DHCP lease.

We can see the following DHCP client behaviour in [RFC 2131 section 4.4](https://datatracker.ietf.org/doc/html/rfc2131#section-4.4):

 ```
--------                               -------
|        | +-------------------------->|       |<-------------------+
| INIT-  | |     +-------------------->| INIT  |                    |
| REBOOT |DHCPNAK/         +---------->|       |<---+               |
|        |Restart|         |            -------     |               |
 --------  |  DHCPNAK/     |               |                        |
    |      Discard offer   |      -/Send DHCPDISCOVER               |
-/Send DHCPREQUEST         |               |                        |
    |      |     |      DHCPACK            v        |               |
 -----------     |   (not accept.)/   -----------   |               |
|           |    |  Send DHCPDECLINE |           |                  |
| REBOOTING |    |         |         | SELECTING |<----+            |
|           |    |        /          |           |     |DHCPOFFER/  |
 -----------     |       /            -----------   |  |Collect     |
    |            |      /                  |   |       |  replies   |
DHCPACK/         |     /  +----------------+   +-------+            |
Record lease, set|    |   v   Select offer/                         |
timers T1, T2   ------------  send DHCPREQUEST      |               |
    |   +----->|            |             DHCPNAK, Lease expired/   |
    |   |      | REQUESTING |                  Halt network         |
    DHCPOFFER/ |            |                       |               |
    Discard     ------------                        |               |
    |   |        |        |                   -----------           |
    |   +--------+     DHCPACK/              |           |          |
    |              Record lease, set    -----| REBINDING |          |
    |                timers T1, T2     /     |           |          |
    |                     |        DHCPACK/   -----------           |
    |                     v     Record lease, set   ^               |
    +----------------> -------      /timers T1,T2   |               |
               +----->|       |<---+                |               |
               |      | BOUND |<---+                |               |
  DHCPOFFER, DHCPACK, |       |    |            T2 expires/   DHCPNAK/
   DHCPNAK/Discard     -------     |             Broadcast  Halt network
               |       | |         |            DHCPREQUEST         |
               +-------+ |        DHCPACK/          |               |
                    T1 expires/   Record lease, set |               |
                 Send DHCPREQUEST timers T1, T2     |               |
                 to leasing server |                |               |
                         |   ----------             |               |
                         |  |          |------------+               |
                         +->| RENEWING |                            |
                            |          |----------------------------+
                             ----------
```
{: .nolineno }

### IP lifetime on network interface: valid_lft and preferred_lft

With `ip` command, we can see there are two variables: `valid_lft` and `preferred_lft`:

```bash
$ ip addr show eth0
2: eth0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 9001 qdisc pfifo_fast state UP group default qlen 1000
    link/ether 12:7a:0f:c6:b4:99 brd ff:ff:ff:ff:ff:ff
    inet 172.31.84.251/20 brd 172.31.95.255 scope global dynamic eth0
       valid_lft 3099sec preferred_lft 3099sec   # <---------------- Here
    inet6 fe80::107a:fff:fec6:b499/64 scope link
       valid_lft forever preferred_lft forever

$ man ip-address

valid_lft LFT
      the valid lifetime of this address; see section 5.5.4 of RFC 4862. When it expires, the address is removed by the kernel.  Defaults to forever.

preferred_lft LFT
      the preferred lifetime of this address; see section 5.5.4 of RFC 4862. When it expires, the address is no longer used for new outgoing connections. Defaults to forever.
```
{: .nolineno }

In [RFC 4862](https://tools.ietf.org/html/rfc4862), we can see the definition of `valid_lft` and `preferred_lft`:

  | Name               | Definition                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
  | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | preferred lifetime | The length of time that a valid address is preferred (i.e., the time until deprecation). When the preferred lifetime expires, the address becomes deprecated.                                                                                                                                                                                                                                                                                                          |
  | valid lifetime     | The length of time an address remains in the valid state (i.e., the time until invalidation). The valid lifetime must be greater than or equal to the preferred lifetime. When the valid lifetime expires, the address becomes invalid.                                                                                                                                                                                                                                |
  | preferred address  | An address assigned to an interface whose use by upper-layer protocols is unrestricted. Preferred addresses may be used as the source (or destination) address of packets sent from (or to) the interface.                                                                                                                                                                                                                                                             |
  | deprecated address | An address assigned to an interface whose use is discouraged, but not forbidden. A deprecated address should no longer be used as a source address in new communications, but packets sent from or to deprecated addresses are delivered as expected. A deprecated address may continue to be used as a source address in communications where switching to a preferred address causes hardship to a specific upper-layer activity (e.g., an existing TCP connection). |
  | valid address      | A preferred or deprecated address. A valid address may appear as the source or destination address of a packet, and the Internet routing system is expected to deliver packets sent to a valid address to their intended recipients.                                                                                                                                                                                                                                   |
  | invalid address    | An address that is not assigned to any interface. A valid address becomes invalid when its valid lifetime expires. Invalid addresses should not appear as the destination or source address of a packet.  In the former case, the Internet routing system will be unable to deliver the packet; in the latter case, the recipient of the packet will be unable to respond to it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

In short, when an address exceed the preferred lifetime, the address will become a deprecated address and can not be used as a source address in new connection. When an address exceed the valid lifetime, the address will become an invalid address and cannot be used anymore. We can see Preferred Lifetime is like a soft limit and Valid Lifetime is like a hard limit:[^2]

> A deprecated address SHOULD continue to be used as a source address in existing communications, but SHOULD NOT be used to initiate new communications if an alternate (non-deprecated) address of sufficient scope can easily be used instead.
>
> An address (and its association with an interface) becomes invalid when its valid lifetime expires. An invalid address MUST NOT be used. as a source address in outgoing communications and MUST NOT be. recognized as a destination on a receiving interface.
>
> With DHCPv6 in particular, the client should attempt to renew the lease before the preferred lifetime ends, but if it is not able to do so, the address will be deprecated (and the client can continue using it if it doesn't have a preferred address) until the valid lifetime ends.

## How is DHCP lease related to instance status check failure:

From some my case handling and lab reproducing, I have seen some use cases that may affect DHCP lease and lead to instance status check failure like changing system time, dhclient failure and the IP lifetime expiration.

### System time change forward/backward

Before, we could sometimes find "Time has been changed" message in the system log which was close to the time when their EC2 instances fail the instance status check and there was no DHCP lease update log after system time was changed:

```bash
$ egrep "(Switching root|DHCPREQUEST|DHCPACK|bound to|System clock|Time has been changed)" messages | nl

Jun 24 09:04:05 ip-172-31-36-147 dhclient[963]: DHCPREQUEST on ens3 to 172.31.32.1 port 67 (xid=0x534f3961)
Jun 24 09:04:05 ip-172-31-36-147 dhclient[963]: DHCPACK from 172.31.32.1 (xid=0x534f3961)
Jun 24 09:04:07 ip-172-31-36-147 dhclient[963]: bound to 172.31.36.147 -- renewal in 1666 seconds.
Jun 23 00:00:00 ip-172-31-36-147 systemd: Time has been changed
```
{: .nolineno }

The EC2 instances would fail the instance status check after a certain time no matter the system passed the expired time or not. It turns out that the dhclient would not request new DHCP lease as the renewal time will be reached. The IP became invalid after `valid_lft` and `preferred_lft` breached.

> Now the dhclient will renew the DHCP lease once the renewal countdown time reach even if the system time is changed, so system time changing may not be a issue anymore. However, if you observe your system will fail the instance health check, it may be worth to check if the dhclient will request DHCP lease renewal or not in your system. You can try the reproduce steps in the section: [Lab to demonstrate the DHCP lease expire issue with time change](https://shihtiy.com/posts/instance-status-check-system-time-dhcp/#lab-to-demonstrate-the-dhcp-lease-expire-issue-with-time-change)
> {: .prompt-warning }

### DHCP client dhclient failure

This is easy to understand as if the dhclient cannot function normally, it cannot request a DHCP lease renew. In this case, the IP will become invalid once it breached the expiration time. We can test it with killing the dhclient process:

```bash
$ ps aux | grep "[d]hclient"
root      2851  0.0  0.4  98688  4464 ?        Ss   13:51   0:00 /sbin/dhclient -q -cf /etc/dhcp/dhclient-eth0.conf -lf /var/lib/dhclient/dhclient--eth0.lease -pf /var/run/dhclient-eth0.pid -H ip-172-31-84-251 eth0
root      2900  0.0  0.4  98688  4088 ?        Ss   13:51   0:00 /sbin/dhclient -6 -nw -lf /var/lib/dhclient/dhclient6--eth0.lease -pf /var/run/dhclient6-eth0.pid eth0 -H ip-172-31-84-251

$ sudo kill -9 2851
```
{: .nolineno }

### Network interface configuration

In some cases, some customer's script somehow will change the network interface configuration. In the following case, you can see the `valid_lft` and `preferred_lft` were changed to 600 seconds will the renewal time will be after 11423 seconds. Once `valid_lft` and `preferred_lft` breached, the IP will become invalid:

```bash
$ sudo ip addr change 172.31.29.120/20 dev eth0 valid_lft 600 preferred_lft 600

$ ip addr show eth0
2: eth0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 9001 qdisc fq_codel state UP group default qlen 1000
    link/ether 0a:9e:71:d8:c9:13 brd ff:ff:ff:ff:ff:ff
    inet 172.31.29.120/20 brd 172.31.31.255 scope global dynamic eth0
       valid_lft 594sec preferred_lft 594sec
    inet6 fe80::89e:71ff:fed8:c913/64 scope link
       valid_lft forever preferred_lft forever

$ sudo egrep "(Switching root|RTC.*localtime|DHCPREQUEST|DHCPACK|bound to|System clock|Time has been changed)" /var/log/messages | nl
     1  May 13 13:26:47 ip-172-31-29-120 dhclient[359]: DHCPREQUEST for 172.31.29.120 on eth0 to 255.255.255.255 port 67 (xid=0xf80ccf9)
     2  May 13 13:26:47 ip-172-31-29-120 dhclient[359]: DHCPACK of 172.31.29.120 from 172.31.16.1 (xid=0xf9cc800f)
     3  May 13 13:26:47 ip-172-31-29-120 dhclient[359]: bound to 172.31.29.120 -- renewal in 1423 seconds.
     4  May 13 13:26:54 ip-172-31-29-120 chronyd[475]: System clock TAI offset set to 37 seconds
     5  May 13 13:31:15 ip-172-31-29-120 dhclient[345]: DHCPREQUEST for 172.31.29.120 on eth0 to 255.255.255.255 port 67 (xid=0x5bf6bc97)
     6  May 13 13:31:15 ip-172-31-29-120 dhclient[345]: DHCPACK of 172.31.29.120 from 172.31.16.1 (xid=0x97bcf65b)
     7  May 13 13:31:15 ip-172-31-29-120 dhclient[345]: bound to 172.31.29.120 -- renewal in 1423 seconds.
```
{: .nolineno }

## Lab to demonstrate the DHCP lease expire issue with time change

The following steps will reproduce the DHCP lease expire issue by moving the OS time forward.

> Before, the renewal time may be longer if I change the dhcp-lease-time time and the DHCP lease will not be renewed before the valid_lft and preferred_lft expired.
> Now, it seems the dhclient will request DHCP renew once the renewal time count down finish so you may not reproduce instance status check failure by these steps anymore.
{: .prompt-warning }

 1. To speed up the lab, we can change the expired time, as [RFC 2131](https://datatracker.ietf.org/doc/html/rfc2131#section-3.5) mentioned that the client can suggest the lease time: 

> In addition, the client may suggest values for the network address and lease time in the DHCPDISCOVER message. The client may include the 'requested IP address' option to suggest that a particular IP address be assigned, and may include the 'IP address lease time' option to suggest the lease time it would like.

```bash
# create a dhclint config file to eth0
$ sudo vi /etc/dhcp/dhclient-eth0.conf

interface "eth0" {
   supersede dhcp-lease-time 180;
}

$ sudo ifdown eth0; sudo ifup eth0

$ ip addr show eth0
2: eth0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 9001 qdisc pfifo_fast state UP group default qlen 1000
    link/ether 12:7a:0f:c6:b4:99 brd ff:ff:ff:ff:ff:ff
    inet 172.31.84.251/20 brd 172.31.95.255 scope global dynamic eth0
       valid_lft 178sec preferred_lft 178sec  # <-------------------------- start to countdown from 180 seconds
    inet6 fe80::107a:fff:fec6:b499/64 scope link
       valid_lft forever preferred_lft forever

$ cat /var/lib/dhclient/dhclient--eth0.lease

lease {
  interface "eth0";
  fixed-address 172.31.84.251;
  option subnet-mask 255.255.240.0;
  option routers 172.31.80.1;
  option dhcp-lease-time 180;
...
...
  renew 6 2023/05/13 14:52:36;
  rebind 6 2023/05/13 14:53:45;
  expire 6 2023/05/13 14:54:08;
}
```
{: .nolineno }

2. Change the system time:

```bash
# disable time sync with NTP
$ sudo timedatectl set-ntp 0

$ sudo timedatectl set-time 2020-06-27

$ timedatectl
      Local time: Sat 2020-06-27 00:00:06 UTC
  Universal time: Sat 2020-06-27 00:00:06 UTC
        RTC time: Sat 2020-06-27 00:00:07
       Time zone: n/a (UTC, +0000)
     NTP enabled: no
NTP synchronized: no
 RTC in local TZ: no
      DST active: n/a

$ sudo egrep "(Switching root|DHCPREQUEST|DHCPACK|bound to|System clock|Time has been changed)" /var/log/messages | nl

105  May 13 09:39:31 ip-172-31-84-251 dhclient[4492]: DHCPREQUEST on eth0 to 172.31.80.1 port 67 (xid=0x2c10a9dc)
106  May 13 09:39:31 ip-172-31-84-251 dhclient[4492]: DHCPACK from 172.31.80.1 (xid=0x2c10a9dc)
107  May 13 09:39:31 ip-172-31-84-251 dhclient[4492]: bound to 172.31.84.251 -- renewal in 85 seconds.
108  Jun 23 00:00:00 ip-172-31-84-251 systemd: Time has been changed
109  Jun 27 00:00:00 ip-172-31-84-251 systemd: Time has been changed
110  Jun 27 00:00:30 ip-172-31-84-251 dhclient[4492]: DHCPREQUEST on eth0 to 255.255.255.255 port 67 (xid=0x28decd99)
111  Jun 27 00:00:30 ip-172-31-84-251 dhclient[4492]: DHCPACK from 172.31.80.1 (xid=0x28decd99)
112  Jun 27 00:00:30 ip-172-31-84-251 dhclient[4492]: bound to 172.31.84.251 -- renewal in 70 seconds.
```
{: .nolineno }

 3. Monitor the output of ip command

```bash
$ output_file="/tmp/output.txt"; cat << EOF > monitor.sh
#!/bin/bash

# File to store output


while true; do
    # Print current system time and UTC time
    echo "System time: $(date)" >> $output_file
    echo "UTC time: $(date -u)" >> $output_file

    # Execute 'ip addr show eth0' command
    ip addr show eth0 >> $output_file

    # Sleep for 1 second
    sleep 1
done
EOF

$ chmod +x monitor.sh

$ ./monitor.sh &
[1] 3953

$ disown 3953

$ cat /tmp/output.txt
System time: Sat Jun 27 00:10:50 UTC 2020
UTC time: Sat Jun 27 00:10:50 UTC 2020
2: eth0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 9001 qdisc pfifo_fast state UP group default qlen 1000
    link/ether 12:7a:0f:c6:b4:99 brd ff:ff:ff:ff:ff:ff
    inet 172.31.84.251/20 brd 172.31.95.255 scope global dynamic eth0
       valid_lft 129sec preferred_lft 129sec
    inet6 fe80::107a:fff:fec6:b499/64 scope link
       valid_lft forever preferred_lft forever
```
{: .nolineno }

4. Confirm if the instance status check failure

The instance will fail the instance status check as soon as the countdown expire. Use Script to print output of `ip addr show eth0` to a log file and we can see the IP address is invalid:

```bash
2: eth0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 9001 qdisc pfifo_fast state UP group default qlen 1000
    link/ether 12:7a:0f:c6:b4:99 brd ff:ff:ff:ff:ff:ff
    inet 172.31.84.251/20 brd 172.31.95.255 scope global dynamic eth0
       valid_lft 129sec preferred_lft 129sec
    inet6 fe80::107a:fff:fec6:b499/64 scope link
       valid_lft forever preferred_lft forever

# When time expired
2: eth0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 9001 qdisc pfifo_fast state UP group default qlen 1000
    link/ether 12:7a:0f:c6:b4:99 brd ff:ff:ff:ff:ff:ff
    inet6 fe80::107a:fff:fec6:b499/64 scope link
       valid_lft forever preferred_lft forever
```
{: .nolineno }

## How to prevent time change from affecting DHCP Lease?

### 1. Workaround: Change to static IP

However, this workaround of static private IP address only eliminate the affect of time change on DHCP lease and other service may still be affected if the time is still changed. Also, if the customer creates an AMI from an instance with the workaround of static private IP address, the new launched instance from that AMI will get a different IP address. The new IP address may not match the network configuration of the static private IP address and thus the new launched instance will fail the instance status check.

```bash
$ cat /etc/sysconfig/network-scripts/ifcfg-ens3
# Created by cloud-init on instance boot automatically, do not edit.
#
BOOTPROTO=dhcp
DEVICE=ens3
HWADDR=0a:24:4e:e9:ab:8c
ONBOOT=yes
TYPE=Ethernet
USERCTL=no

$ sudo vi /etc/sysconfig/network-scripts/ifcfg-ens3

DEVICE=ens3
HWADDR=0a:24:4e:e9:ab:8c
ONBOOT=yes
TYPE=Ethernet
USERCTL=no
BOOTPROTO=none
IPADDR="172.31.36.147"
NETMASK="255.255.240.0"
GATEWAY="172.31.32.1"

$ sudo systemctl restart network

$ ip addr show ens3
2: ens3: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 9001 qdisc mq state UP group default qlen 1000
    link/ether 0a:24:4e:e9:ab:8c brd ff:ff:ff:ff:ff:ff
    inet 172.31.36.147/20 brd 172.31.47.255 scope global ens3
       valid_lft forever preferred_lft forever
    inet6 fe80::824:4eff:fee9:ab8c/64 scope link
       valid_lft forever preferred_lft forever
```
{: .nolineno }

### 2. Update the DHCP lease if the application/lab require to set the time back and forward:

We can update the DHCP lease by the following steps:

1. Disable and stop ntpd/chronyd

```bash
$ sudo systemctl disable chronyd.service
$ sudo systemctl stop chronyd.service
```
{: .nolineno }

2. Move the system time (ex. 2023-12-31)

```bash
$ sudo date --set '20231231'
Tue Dec 31 00:00:00 UTC 2023
```
{: .nolineno }

3. Make interface Down and Up to reset DHCP lease

```bash
$ sudo ifdown eth0; sudo ifup eth0

$ sudo ip link set eth0 down; sudo ip link set eth0 up;
```
{: .nolineno }

### 3. Find out which process change the OS time

It is better to help the customer identify which process keeps changing the OS time. We can do it with auditd to find out which process all the time-related system call:

```bash
$ sudo auditctl -a always,exit -F arch=b64 -S adjtimex,settimeofday,clock_settime -k time-change
```
{: .nolineno }

To help the customer to narrow down the time change issue if the customer cannot identify the time change activity,  we can filter the record by:

```bash
$ ausearch -k time-change
```
{: .nolineno }

For example:

```bash
$ ausearch -k time-change | grep ntpdate
type=SYSCALL msg=audit(1619799540.147:103): arch=c000003e syscall=159 success=yes exit=0 a0=7ffce23e2410 a1=7ffce23e25a0 a2=861 a3=39 items=0 ppid=1302 pid=1353 auid=1000 uid=0 gid=0 euid=0 suid=0 fsuid=0 egid=0 sgid=0 fsgid=0 tty=pts0 ses=1 comm="ntpdate" exe="/usr/sbin/ntpdate" subj=unconfined_u:unconfined_r:unconfined_t:s0-s0:c0.c1023 key="time-change"
```
{: .nolineno }

## References

- [Dynamic Host Configuration Protocol - Wikipedia](https://en.wikipedia.org/wiki/Dynamic_Host_Configuration_Protocol)
- [RFC 2131 - Dynamic Host Configuration Protocol](https://datatracker.ietf.org/doc/html/rfc2131)
- [RFC 4862 - IPv6 Stateless Address Autoconfiguration](https://datatracker.ietf.org/doc/html/rfc4862)

[^1]: Covert Communications through Network Configuration Messages - Scientific Figure on ResearchGate. Available from [researchgate](https://www.researchgate.net/figure/Message-exchange-models-in-DHCP_fig1_259117702)
[^2]: [RFC 4862 - IPv6 Stateless Address Autoconfiguration](https://datatracker.ietf.org/doc/html/rfc4862#section-5.5.4)
