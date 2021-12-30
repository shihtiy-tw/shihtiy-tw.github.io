---

title: '[Linux] Max open file limit with system service'
date: 2021-12-29 15:50:02 +0000
categories: [CSIE, Linux]
tags: [linux, systemd, ulimit, sudo, pam]
---

## Introduction

This article will go through an interesting configuration topics for:

- the max open file limit with system service (systemd daemon service)
- the relation between PAM (Pluggable Authentication Modules) and `/etc/security/limit.conf`
- the difference between CentOS7 and Ubuntu 20.04 on this matter

## Scenario

When we want to modify the limit for max open file of the Linux process, we will configure the limit in `/etc/security/limit.conf`. For example, to set both the soft and hard limit to `65534` for open file (file descriptors):

```bash
$ cat /etc/security/limits.conf | grep nofile
* soft nofile 65534
* hard nofile 65534

$ sudo reboot

$ ulimit -Hn
65534

$ ulimit -Sn
65534
```

## Issue Description

However, under the configuration mentioned above (both the soft and hard limit to `65534`), with AWS System Manager(SSM) Run Command function[^1] to execute command, we will find that the following situations for the process on a CentOS7 instance:

- When the command is without `sudo`:
    - The soft limit will be `1024`.
    - The hard limit will be `4096`.
- When the command is with `sudo`:
    - The soft limit and hard limit will both be `65534`

Why does the soft and hard limit of max opened file for process will be different if a command is executed with `sudo` or not?

## Explanation

### The scope for `/etc/security/limits.conf`

First, we need to know that the configuration in `/etc/security/limits.conf` is only effective for the users logged in via PAM:

```bash
$ cat /etc/security/limits.conf
# /etc/security/limits.conf
#
#This file sets the resource limits for the users logged in via PAM.
#It does not affect resource limits of the system services.
```

And we also notice that `/etc/security/limits.conf` does not affect the system services (daemon service).

### PAM (Pluggable Authentication Modules)

PAM is a module to authenticate user for the programs on Linux.[^2] PAM will authenticate the program (login, su etc) according to the PAM configuration in `/etc/pam.d/`. For instance, the PAM configuration for `sudo` on CentOS 7 will be:

```bash
$ cat /etc/pam.d/sudo
#%PAM-1.0
auth       include      system-auth
account    include      system-auth
password   include      system-auth
session    optional     pam_keyinit.so revoke
session    include      system-auth
```

We can further check the configuration `system-auth` included for `sudo`:

```bash
$ cat /etc/pam.d/system-auth
#%PAM-1.0
# This file is auto-generated.
# User changes will be destroyed the next time authconfig is run.
...
session     optional      pam_keyinit.so revoke
session     required      pam_limits.so  <======================= Use /etc/security/limit.conf
...
```

In `/etc/pam.d/system-auth`, it will use a module called `pam_limits.so`. According to the [pam_limits man page](https://www.man7.org/linux/man-pages/man8/pam_limits.8.html), this module will refer to `/etc/security/limits.conf` to set the resource limit during the user login/execute command (the period is called session):

> The pam_limits PAM module sets limits on the system resources that can be obtained in a user-session. Users of uid=0 are affected by this limits, too.
> By default limits are taken from the /etc/security/limits.conf config file...

### Command with sudo and without sudo

Therefore, when we use SSM to execute command with `sudo` (authenticated through `/etc/pam.d/sudo`) or execute `su` (authenticated through `/etc/pam.d/su`) on a CentOS7 system, the PAM will use `pam_limits.so` module for authentication and thus the max open file limit of the process executed with `sudo` will refer to `/etc/security/limits.conf`, which is `65534`.

Without `sudo` the command will not go though PAM authentication, the process will inherit the limit for the parent process and the limit will be `1024` for soft limit and `4096` for hard limit in this scenario.

### CentOS and Ubuntu

We can also notice that this behaviour cannot be reproduced on an Ubuntu system. It is because the PAM configuration for `sudo` on Ubuntu does not include `pam_limits.so` module:

```bash
$ cat /etc/pam.d/sudo
#%PAM-1.0

session    required   pam_env.so readenv=1 user_readenv=0
session    required   pam_env.so readenv=1 envfile=/etc/default/locale user_readenv=0
@include common-auth
@include common-account
@include common-session-noninteractive
```

We can check all the included PAM modules `/etc/pam.d/common-auth`, `/etc/pam.d/common-account` and `/etc/pam.d/common-session-noninteractive`, we will see none of them include `pam_limits.so`. Therefore, even though we execute command with `sudo` on Ubuntu, the process will not use the configuration in `/etc/security/limits.conf`.

## Solution

As `/etc/security/limits.conf` does not affect the system service, we can configure the resource limit for system service by:

- systemd.unit (certain systemd service)[^3]
- systemd-system.conf (all services under systemd)[^4]

### systemd.unit

#### Usage

In a systemd.unit, we can configure the resource limit for certain systemd service by the following steps:

1. Create an `drop-in` directory under `/etc/systemd/system`
2. Create a file with extension `.conf`

When systemd pursers the service unit file for systemd service, systemd will also purser the configuration files in `drop-in` directory. In this way, we needn't change any configuration in the service unit file, as mentioned in the [systemd.unit man page](https://man7.org/linux/man-pages/man5/systemd.unit.5.html):

> Along with a unit file foo.service, a "drop-in" directory foo.service.d/ may exist. All files with the suffix ".conf" from this directory will be parsed after the unit file itself is parsed. This is useful to alter or add configuration settings for a unit, without having to modify unit files. Drop-in files must contain appropriate section headers.

#### Example

Take `amazon-ssm-agent` daemon service for example:

1. check the amazon-ssm-agent original max open files limit ：

```bash
$ cat /proc/$(pidof amazon-ssm-agent)/limits | grep files
Max open files            1024                 4096                 files
```

2. Create a `drop-in` directory：

```bash
$ sudo mkdir -p /etc/systemd/system/amazon-ssm-agent.service.d/
```

3. Add a configuration file with extension `.conf`：

```bash
$ sudo vi /etc/systemd/system/amazon-ssm-agent.service.d/filelimit.conf
```

4. Add these two lines (according to the man page of systemd.service：The service specific configuration options are configured in the [Service] section)：

```config
[Service]
LimitNOFILE=2048:8192
```

5. Reload systemd configuration and restart the `amazon-ssm-agnet` daemon service：

```bash
$ sudo systemctl daemon-reload
$ sudo systemctl restart amazon-ssm-agent
```

6. Confirm the `amazon-ssm-agent` process use the max open file limit:

```bash
$ cat /proc/$(pidof amazon-ssm-agent)/limits | grep files
Max open files            2048                 8192                 files
```

### systemd-system.conf

#### Usage

In `systemd-system.conf`, we can configure the limit for all the systemd service by the following step:

- Create a configuration file with extension `.conf` in `/etc/systemd/system.conf.d`

With the step, we needn't to change the configuration under `/etc/systemd/system.conf`, as mentioned in the [systemd-system.conf man page](https://man7.org/linux/man-pages/man5/systemd-system.conf.5.html):

> When run as a system instance, systemd interprets the configuration file system.conf and the files in system.conf.d directories;
> ...
> By default, the configuration file in /etc/systemd/ contains commented out entries showing the defaults as a guide to the administrator. This file can be edited to create local overrides.

#### Example

Take `sshd` daemon service for example:

1. Check `sshd` max open files limit：

```bash
$ systemctl status sshd | grep -i pid
 Main PID: 1596 (sshd)

$ cat /proc/1596/limits | grep files
Max open files            1024                 4096                 files
```

2. Create `/etc/systemd/system.conf.d` directory：

```bash
$ sudo mkdir /etc/systemd/system.conf.d
```

3. Create an configuration file with extension `.conf`：

```bash
$ sudo vi /etc/systemd/system.conf.d/filelimit.conf
```

Add the following two lines (according to `systemd-system.conf` man page ：All options are configured in the [Manager] section)：

```config
[Manager]
DefaultLimitNOFILE=3072:12288
```

4. Reboot the system：

```bash
$ sudo reboot
```

5. Confirm `sshd` process use new max open file limit:

```bash
$ systemctl status sshd | grep -i pid
 Main PID: 1105 (sshd)

$ cat /proc/1105/limits | grep files
Max open files            3072                 12288                files
```

6. We can see the `amazon-ssm-agent` process still use its own configuration. `amazon-ssm-agent` will not use the systemd-wide configuration:

```bash
$ cat /proc/$(pidof amazon-ssm-agent)/limits | grep files
Max open files            2048                 8192                 files
```

## References

[^1]: [AWS Systems Manager Run Command](https://docs.aws.amazon.com/systems-manager/latest/userguide/execute-remote-commands.html)
[^2]: [PAM(8) - Linux manual page](https://man7.org/linux/man-pages/man8/pam.8.html)
[^3]: [systemd.unit(5) - Linux manual page](https://man7.org/linux/man-pages/man5/systemd.unit.5.html)
[^4]: [systemd-system.conf(5) - Linux manual page](https://man7.org/linux/man-pages/man5/systemd-system.conf.5.html)
