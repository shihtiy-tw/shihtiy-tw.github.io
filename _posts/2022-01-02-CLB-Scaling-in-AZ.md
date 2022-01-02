---

title: '[AWS] Which AZ will CLB scale?'
date: 2022-01-02 17:20:24 +0000
categories: [AWS, Networking]
tags: [elb, aws, scaling]
---


## Introduction

When under the following conditions:

- CLB enables multiple AZs.
- Cross-zone load balancing is disabled.
- Healthy backend instances only locate in one of the AZs.

CLB DNS only register the IPs of the AZ where the healthy backend instance locate.[^1] Therefore, some people may wonder CLB will scale:

- All enabled AZ?
- AZ with backends?
- Or AZ with healthy backends?

This article records a simple lab for CLB scaling under the conditions mentioned above.

## Scenarios

In these three different scenarios below:

1.  Scenario #1: test if CLB only scales in AZ with healthy backends

    | AZ enabled | if backend instance exist | backend health |
    |:----------:|:-------------------------:|:--------------:|
    | us-east-1a |            Yes            |     health     |
    | us-east-1b |            Yes            |   unhealthy    |

2.  Scenario #2: test if CLB scales in all enabled AZ

    | AZ enabled | if backend instance exist | backend health |
    |:----------:|:-------------------------:|:--------------:|
    | us-east-1a |            No             |      none      |
    | us-east-1b |            Yes            |   unhealthy    |
    | us-east-1c |            Yes            |     health     |

3.  Scenario #3: test if CLB scales in AZ with backends

    | AZ enabled | if backend instance exist | backend health |
    |:----------:|:-------------------------:|:--------------:|
    | us-east-1a |            Yes            |     health     |
    | us-east-1b |            Yes            |   unhealthy    |
    | us-east-1c |            Yes            |     health     |

I will do use ab[^2] to increase the load on CLB to let CLB scale and check which AZ will the CLB scales.

### Scenario #1: test if CLB only scales in AZ with healthy backends

| AZ enabled | if backend instance exist | backend health |
|:----------:|:-------------------------:|:--------------:|
| us-east-1a |            Yes            |     health     |
| us-east-1b |            Yes            |   unhealthy    |

1.  Check the backend instances:
    ```bash
    $ aws ec2 describe-instances \
      --instance-ids $(aws elb describe-instance-health --load-balancer-name CLB-Test --query  'InstanceStates[].InstanceId' --output text) \
      --query 'Reservations[*].Instances[*].[PrivateDnsName,Placement.AvailabilityZone]' \
      --output table
    -------------------------------------------------
    |               DescribeInstances               |
    +--------------------------------+--------------+
    |  ip-172-31-33-197.ec2.internal |  us-east-1a  |
    |  ip-172-31-12-183.ec2.internal |  us-east-1b  |
    +--------------------------------+--------------+
    ```

2.  Check the ENIs for CLB:
    ```bash
    $ aws ec2 describe-network-interfaces | jq  -r '.NetworkInterfaces[] | select(.Description | contains("CLB-Test")) | {IP:.Association.PublicIp, AZ:.AvailabilityZone}'

    {
      "IP": "3.212.184.186",
      "AZ": "us-east-1b"
    }
    {
      "IP": "52.54.181.219",
      "AZ": "us-east-1a"
    }
    ```

3.  Confirm only the IP of the AZ with healthy backend in CLB DNS record:

    ```bash
    $ dig +short CLB-Test-1513212108.us-east-1.elb.amazonaws.com
    52.54.181.219
    ```

4.  Use ab command to test CLB.

5.  See the CLB scaled in both AZs no matter the backend is healthy or not:

    ```bash
    $ aws ec2 describe-network-interfaces | jq  -r '.NetworkInterfaces[] | select(.Description | contains("CLB-Test")) | {IP:.Association.PublicIp, AZ:.AvailabilityZone}'
    {
      "IP": "3.214.48.44",
      "AZ": "us-east-1b"
    }
    {
      "IP": "3.212.184.186",
      "AZ": "us-east-1b"
    }
    {
      "IP": "52.54.213.202",
      "AZ": "us-east-1a"
    }
    {
      "IP": "52.54.181.219",
      "AZ": "us-east-1a"
    }
    ```

### Scenario #2: test if CLB scales in all AZ

| AZ enabled | if backend instance exist | backend health |
|:----------:|:-------------------------:|:--------------:|
| us-east-1a |            No             |      none      |
| us-east-1b |            Yes            |   unhealthy    |
| us-east-1c |            Yes            |     health     |

1.  Check the backend instances:
    ```bash
    $ aws ec2 describe-instances \
      --instance-ids $(aws elb describe-instance-health --load-balancer-name CLB-Test --query  'InstanceStates[].InstanceId' --output text) \
      --query 'Reservations[*].Instances[*].[PrivateDnsName,Placement.AvailabilityZone]' \
      --output table

    -------------------------------------------------
    |               DescribeInstances               |
    +--------------------------------+--------------+
    |  ip-172-31-86-255.ec2.internal |  us-east-1c  |
    |  ip-172-31-2-69.ec2.internal   |  us-east-1b  |
    +--------------------------------+--------------+
    ```

2.  Check the ENIs for CLB:
    ```bash
    $ aws ec2 describe-network-interfaces | jq  -r '.NetworkInterfaces[] | select(.Description | contains("CLB-Test")) | {IP:.Association.PublicIp, AZ:.AvailabilityZone}'

    {
      "IP": "3.210.180.211",
      "AZ": "us-east-1b"
    }
    {
      "IP": "3.230.196.107",
      "AZ": "us-east-1c"
    }
    {
      "IP": "52.86.145.124",
      "AZ": "us-east-1a"
    }
    ```

3.  Confirm only the IP of the AZ with healthy backend in CLB DNS record:

    ```bash
    $ dig CLB-Test-1593697151.us-east-1.elb.amazonaws.com +short
    3.230.196.107
    ```

4.  Use ab command to test CLB.

5.  See the CLB did not scale the enabled AZ without any backend which is us-east-1c in this lab:

    ```bash
    $ aws ec2 describe-network-interfaces | jq  -r '.NetworkInterfaces[] | select(.Description | contains("CLB-Test")) | {IP:.Association.PublicIp, AZ:.AvailabilityZone}'
    {
      "IP": "54.86.219.139",
      "AZ": "us-east-1c"
    }
    {
      "IP": "3.230.196.107",
      "AZ": "us-east-1c"
    }
    {
      "IP": "3.210.180.211",
      "AZ": "us-east-1b"
    }
    {
      "IP": "3.211.33.87",
      "AZ": "us-east-1b"
    }
    {
      "IP": "52.86.145.124",
      "AZ": "us-east-1a"
    }
    ```

### Scenario #3: test if CLB scales in AZ with backends

| AZ enabled | if backend instance exist | backend health |
|:----------:|:-------------------------:|:--------------:|
| us-east-1a |            Yes            |     health     |
| us-east-1b |            Yes            |   unhealthy    |
| us-east-1c |            Yes            |     health     |

1.  Follow the scenario #2, I add another backend instance to us-east-1a:

    ```bash
    $ aws ec2 describe-instances \
      --instance-ids $(aws elb describe-instance-health --load-balancer-name CLB-Test --query  'InstanceStates[].InstanceId' --output text) \
      --query 'Reservations[*].Instances[*].[PrivateDnsName,Placement.AvailabilityZone]' \
      --output table
    -------------------------------------------------
    |               DescribeInstances               |
    +--------------------------------+--------------+
    |  ip-172-31-86-255.ec2.internal |  us-east-1c  |
    |  ip-172-31-33-197.ec2.internal |  us-east-1a  |
    |  ip-172-31-2-69.ec2.internal   |  us-east-1b  |
    +--------------------------------+--------------+
    ```

2.  See the CLB scale in us-east-1a as well:

    ```bash
    $ aws ec2 describe-network-interfaces | jq  -r '.NetworkInterfaces[] | select(.Description | contains("CLB-Test")) | {IP:.Association.PublicIp, AZ:.AvailabilityZone}'
    {
      "IP": "52.86.145.124",
      "AZ": "us-east-1a"
    }
    {
      "IP": "52.55.108.164",
      "AZ": "us-east-1a"
    }
    {
      "IP": "54.86.219.139",
      "AZ": "us-east-1c"
    }
    {
      "IP": "3.230.196.107",
      "AZ": "us-east-1c"
    }
    {
      "IP": "3.211.33.87",
      "AZ": "us-east-1b"
    }
    {
      "IP": "3.210.180.211",
      "AZ": "us-east-1b"
    }
    ```

## Summary

From the labs above, we can see that the CLB scales in **the enabled AZ with any backend instance** no matter the backend instance is healthy or not.

For CLB with cross-zone disabled, balancing the backends capacity in all the enable AZs is a better way as typically the requests on each IP of CLB may be roughly balancing (but it still depends on the behaviour of clients, name server, resolver).

For CLB with cross-zone enabled, it may not be needed to balance the backend capacity in each AZ, but the client may experience cross-zone latency.[^3]

## References

[^1]: [How Elastic Load Balancing works - Request routing](https://docs.aws.amazon.com/elasticloadbalancing/latest/userguide/how-elastic-load-balancing-works.html#request-routing)
[^2]: [ab - Apache HTTP server benchmarking tool - Apache HTTP Server Version 2.4](https://httpd.apache.org/docs/2.4/programs/ab.html)
[^3]: [Improving Performance and Reducing Cost Using Availability Zone Affinity - AWS Architecture Blog](https://aws.amazon.com/blogs/architecture/improving-performance-and-reducing-cost-using-availability-zone-affinity/)
