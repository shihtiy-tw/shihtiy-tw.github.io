---

title: [Linux] NFS client port
date: 2021-12-30 16:17:17 +0000
categories: [CSIE, Linux]
tags: [linux, nfs, tcp, ip, firewall]
---


## Introduction

This article will go through how NFS client choose the port for communication with NFS server.

## Scenario

Network File System (NFS) is a protocol to allow a client to access files on a remote server over a network like local storage.[^1] To secure and restrict the access from clients to the files on a remote server, a administrator usually will use firewall to limit the access resources.

On AWS, VPC provides several firewall configurations, the basic firewall configurations are the followings:

- security group:[^2]
    - a stateful firewall at the network interface(ENI) level
- network access control list (ACL):[^3]
    - a stateless firewall at the subnet level. 

## Issue Description

When using Amazon Elastic File System (Amazon EFS), which support NFS, on the EFS side, it requires the configuration of security groups and the security groups should allow inbound access for the TCP protocol on the NFS port from the clients (EC2 instances).[^4] However, if we configure NACL on the subnets of EFS, we not only need to allow the inbound traffic from the clients to the port 2049(NFS port), but we also need to consider the outbound traffic to the client from EFS back to the clients.

For NACL, we need to know what the port range the NFS client will use for communication with NFS server, or we will get timeout if the NACL does not allow the traffic from EFS to the clients.

## Explanation

### Ephemeral port

Typically, when a client communicate with service on a server, each transport communication (or [network socket](https://en.wikipedia.org/wiki/Network_socket)) is identified by the five-tuple(or **socket address**):

- Protocol
- Source Address
- Destination Address
- Source Port
- Destination Port

Services are usually located at fixed, ["well-known" ports](https://en.wikipedia.org/wiki/List_of_TCP_and_UDP_port_numbers), for example, HTTP services usually listen on port 80 and HTTPS services usually listen on port 443. For client side, no fixed port is defined and a port is chosen automatically by the client. Ports chosen automatically by the networking stack are known as ephemeral ports.

According to [RFC 6056](https://datatracker.ietf.org/doc/html/rfc6056#section-3.2), the ephemeral port range should be 1024-65535.

However, if we only allow port 1024-65535 for outbound traffic on the NACL of the subnets where EFS locates, we will get timeout when we try to mount the EFS from an EC2 instances from a different subnet (same AZ).

### Privileged source port for NFS client

For an NFS client, it's worth noting that the source port will not be the ephemeral port(1024-65535) as we expected for a transport connection. If we check an ESTABLISH connection for NFS, we will see the connection locates on a privileged port (a port number below 1024 and only a process with root privileges may create a socket with a privileged port):

```bash
$ sudo mount -t nfs4 -o nfsvers=4.1,rsize=1048576,wsize=1048576,hard,timeo=600,retrans=2,resvport fs-xxx.efs.us-east-1.amazonaws.com:/ /mnt

$ sudo netstat -tanpo | grep 2049
tcp        0      0 172.31.38.122:711       172.31.35.153:2049      ESTABLISHED -                    keepalive (27.52/0/0)
```

From [NFS man page](https://linux.die.net/man/5/nfs), it explains that NFS client use privileged port for security reason:

> The NFS client can choose any source port value for its sockets, but usually chooses a _privileged_ port...
> As described above, the traditional default NFS authentication scheme, known as AUTH_SYS, relies on sending local UID and GID numbers to identify users making NFS requests. An NFS server assumes that if a connection comes from a privileged port, the UID and GID numbers in the NFS requests on this connection have been verified by the client's kernel or some other local authority.

The privileged port range is defined by kernel parameter: max_resvport and min_resvport[^5]

```bash
$ sysctl -a | grep resvport
sunrpc.max_resvport = 1023
sunrpc.min_resvport = 665
```

If we allow the outbound traffic on the NACL of the EFS's subnets to the privileged port range of the client, the client will mount the EFS successfully.

## Summary

Even though we can allow the privileged port of the clients on the NACL for EFS, the configuration will be difficult and complex because:

- the privileged port ranges depend on the system configuration of the client side
- the NACL is subnet-level firewall, we need to consider other service in the same subnet if any security concern raise when allow outbound for privileged port

If no other specific business use case or concern, we can use security group on EFS to allow inbound traffic from client side without concerning the client source port.

## References

[^1]: [Network File System - Wikipedia](https://en.wikipedia.org/wiki/Network_File_System)
[^2]: [Security groups for your VPC](https://docs.aws.amazon.com/vpc/latest/userguide/VPC_SecurityGroups.html)
[^3]: [Network ACLs](https://docs.aws.amazon.com/vpc/latest/userguide/vpc-network-acls.html)
[^4]: [Creating security groups](https://docs.aws.amazon.com/efs/latest/ug/accessing-fs-create-security-groups.html)
[^5]: [https://www.kernel.org/doc/Documentation/admin-guide/kernel-parameters.txt](https://www.kernel.org/doc/Documentation/admin-guide/kernel-parameters.txt)