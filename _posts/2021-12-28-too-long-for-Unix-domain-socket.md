---
title: "[Linux] Why do I run into '...too long for Unix domain socket' when git clone with SSH?"
categories: [CSIE, Linux]
date: 2021-12-28 22:00:00 +0000
tags: [linux, ssh, git, socket]
crosspost_to_medium: true

---

## Summary

This article will go through why we may will run into `... too long for Unix domain socket` issue when git clone with SSH after they configure the `ControlMaster` and `ControlPath` to accelerate the SSH connection.

## Scenario

When using SSH, people may want to speed up the SSH connection establishment with configuration of ControlMaster and ControlPath. According to the [ssh_config man page](https://linux.die.net/man/5/ssh_config):

```
ControlMaster
Enables the sharing of multiple sessions over a single network connection...

ControlPath
Specify the path to the control socket used for connection sharing as described in the ControlMaster section above or the string ''none'' to disable connection sharing...
```
{: .nolineno }

When using SSH, people may want to speed up the SSH connection establishment with configuration of ControlMaster and ControlPath. According to [the ssh_config man page](https://linux.die.net/man/5/ssh_config):

```
ControlMaster
Enables the sharing of multiple sessions over a single network connection...
ControlPath
Specify the path to the control socket used for connection sharing as described in the ControlMaster section above or the string ''none'' to disable connection sharing...
```

This means that with multiple SSH session with the control socket to speed up the SSH connection establishment.

## Issue

When we try to pull git repo from CodeCoommit, we may run into the following error:

```bash
git clone ssh://git-codecommit.xxx.amazonaws.com/v1/repos/xxx
Cloning into 'xxx'...
unix_listener: "/Users/xxxxxxxxxx/.ssh/master-xxx@git-codecommit.xxx:22" too long for Unix domain socket
Cloning into 'xxx'...
unix_listener: "/Users/xxxxxxxxxx/.ssh/master-xxx@git-codecommit.xxx:22" too long for Unix domain socket
fatal: Could not read from remote repository.
```

And from the ~/.ssh/config, we can see the following configuration:

```config
host *
ControlMaster auto
ControlPath ~/.ssh/master-%r@%h:%p
```
{: .nolineno }

## Explanation

### Unix socket path length

The messages `unix_listener: ... too long for Unix domain socket` is from the function to create socket ([source code](https://github.com/openssh/openssh-portable/blob/9ada37d36003a77902e90a3214981e417457cf13/misc.c#L1070)):

```c
int
unix_listener(const char *path, int backlog, int unlink_first)
{
	struct sockaddr_un sunaddr;
	int saved_errno, sock;

	memset(&sunaddr, 0, sizeof(sunaddr));
	sunaddr.sun_family = AF_UNIX;
	if (strlcpy(sunaddr.sun_path, path, sizeof(sunaddr.sun_path)) >= sizeof(sunaddr.sun_path)) {
		error("%s: \"%s\" too long for Unix domain socket", __func__,
		    path);
		errno = ENAMETOOLONG;
		return -1;
	}
```
{: .nolineno }

We can see that if the socket path is longer then `sizeof(sunaddr.sun_path)`, and then we will get the error message `unix_listener: ... too long for Unix domain socket`. In unix socket man page, it describes that the length of sun_path is `108` char ([source code](https://linux.die.net/man/7/unix)):

```c
#define UNIX_PATH_MAX    108

struct sockaddr_un {
    sa_family_t sun_family;               /* AF_UNIX */
    char        sun_path[UNIX_PATH_MAX];  /* pathname */
};
```
{: .nolineno }

### SSH config for ControlPath

Why the socket path in the use case is longer than `108` char? When configuring the `ControlPath` parameter as `~/.ssh/master-%r@%h:%p`, according to the [ssh_config man page](https://man.openbsd.org/ssh_config.5), this means the following, :
host *
ControlMaster auto
ControlPath ~/.ssh/master-%r@%h:%p
```

## Explanation

The messages `unix_listener: ... too long for Unix domain socket` is from the function to create socket ([source code](https://github.com/openssh/openssh-portable/blob/9ada37d36003a77902e90a3214981e417457cf13/misc.c#L1070)):

```c
int
unix_listener(const char *path, int backlog, int unlink_first)
{
 struct sockaddr_un sunaddr;
 int saved_errno, sock;
 memset(&sunaddr, 0, sizeof(sunaddr));
 sunaddr.sun_family = AF_UNIX;
 if (strlcpy(sunaddr.sun_path, path, sizeof(sunaddr.sun_path)) >= sizeof(sunaddr.sun_path)) {
 error("%s: \"%s\" too long for Unix domain socket", __func__,
     path);
 errno = ENAMETOOLONG;
 return -1;
 }
```

We can see that if the socket path is longer then `sizeof(sunaddr.sun_path)`, then we will get the error messages `unix_listener: ... too long for Unix domain socket`. In unix socket man page, it describes that the length of sun_path is `108` ([source code](https://linux.die.net/man/7/unix)):

```c
#define UNIX_PATH_MAX    108
struct sockaddr_un {
    sa_family_t sun_family;               /* AF_UNIX */
    char        sun_path[UNIX_PATH_MAX];  /* pathname */
};
```

And why the socket path in the use case is longer than 108? When the configuration of the `ControlPath` as `~/.ssh/master-%r@%h:%p`, which means the following, according to [the ssh_config man page](https://man.openbsd.org/ssh_config.5):

- '%h': target host name
- '%p': the port
- '%r': the remote login username

With AWS CodeCommit, the remote login user name is the SSH key ID, the host name is the CodeCommit endpoint[^2]. Due to this combination, it may be longer than the `108` char and cause the error message `unix_listener: ... too long for Unix domain socket`:

```bash
$ echo "/Users/xxxxxxxxxx/.ssh/master-xxx@git-codecommit.xxx:22" | wc -m
115
```
{: .nolineno }

## Solution

To solve the long `ControlPath` issue, we can replace the parameter with `%C` which is Hash of `%l%h%p%r`[^1] and decrease the chance for `ControlPath` to be longer than `108` char:

```config
host *
ControlMaster auto
ControlPath ~/.ssh/master-%C
```
{: .nolineno }

We can see the length of the socket path is much less then the length limit and we can avoid the socket length issue with `ControlPath`:

```bash
$ ls ~/.ssh | grep master
master-e7f58eb55da9db1a90b39dba271ef9c92838e09a
$ echo "/home/shihtiy/.ssh/master-e7f58eb55da9db1a90b39dba271ef9c92838e09a" | wc -m
67
```
{: .nolineno }

## References

[^2]: [Setup steps for SSH connections to AWS CodeCommit repositories on Linux, macOS, or Unix ](https://docs.aws.amazon.com/codecommit/latest/userguide/setting-up-ssh-unixes.html)
[^1]: [ssh_config(5) - OpenBSD manual pages](https://man.openbsd.org/ssh_config.5)
With CodeCommit, the remote login user name is the SSH key ID, the host name is the CodeCommit endpoint. Due to this combination, it may be longer than the 108 char and cause the error messages `unix_listener: ... too long for Unix domain socket`:

```bash
$ echo "/Users/xxxxxxxxxx/.ssh/master-xxx@git-codecommit.xxx:22" | wc -m
115
```

## Solution

To solve the long `ControlPath` issue, we can replace the parameter with `%C` which is Hash of `%l%h%p%r`[^1] and decrease the chance for `ControlPath` to be longer than 108 characters:

```config
host *
ControlMaster auto
ControlPath ~/.ssh/master-%C
```

We can see the length of the socket path is much less then the length limit and we can avoid the socket length issue with `ControlPath`:

```bash
$ ls ~/.ssh | grep master
master-e7f58eb55da9db1a90b39dba271ef9c92838e09a
$ echo "/home/shihtiy/.ssh/master-e7f58eb55da9db1a90b39dba271ef9c92838e09a" | wc -m
67
```

[^1]: https://man.openbsd.org/ssh_config.5
## References

[^2]: [Setup steps for SSH connections to AWS CodeCommit repositories on Linux, macOS, or Unix ](https://docs.aws.amazon.com/codecommit/latest/userguide/setting-up-ssh-unixes.html)
[^1]: https://man.openbsd.org/ssh_config.5
>>>>>>> f64fc4a ([posts]: 2021-12-28-too-long-for-Unix-domain-socket publish)
