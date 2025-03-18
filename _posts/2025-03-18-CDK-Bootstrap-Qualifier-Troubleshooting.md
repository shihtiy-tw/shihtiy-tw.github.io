---
aliases: []
append_modified_update: true
title: 'AWS CDK Deployment Insights: Troubleshooting the "SSM Parameter /cdk-bootstrap/hnb659fds/version not found" Error'
date: 2025-03-18 10:39:26 +0000
categories:
  - CSIE
  - AWS
  - CDK
tags:
  - cdk
  - aws
  - ssm
modified:
  - 2025-03-18T15:30:44+00:00
date created: Tuesday, March 18th 2025, 10:38:54 am
date modified: Tuesday, March 18th 2025, 5:58:40 pm
---

## Introduction

Deploying applications using the AWS Cloud Development Kit (CDK) provides a way to provision and manage cloud infrastructure as code. However, occasionally users may encounter errors where the deployment fails to find a required resource, such as an SSM parameter. One common error message is:

> SSM parameter /cdk-bootstrap/hnb659fds/version not found. Has the environment been bootstrapped? Please run 'cdk bootstrap'.

In this article, we'll explore the root cause of this error and provide step-by-step guidance on how to prevent and resolve it.

## Background

### Understanding the CDK Bootstrap Process

When users first use the AWS CDK in a new environment, users need to run the `cdk bootstrap` command to set up the required resources.[^1] This process creates a CloudFormation stack that provisions infrastructure like an S3 bucket, IAM roles and ECR repository needed by the CDK. When the users check their CloudFormation stack, they will see a stack named as `CDKToolkit` with resources naming as `cdk-qualifier-description-account-ID-Region`:

- Qualifier–A nine character unique string value of `hnb659fds`. The actual value has no significance.
- Description–A short description of the resource. For example, container-assets.
- Account ID–The AWS account ID of the environment.
- Region–The AWS Region of the environment.

The bootstrap process creates an SSM parameter named `/cdk-bootstrap/hnb659fds/version` to track the version of the bootstrap stack. This parameter is then referenced by subsequent CDK deployments to ensure consistency.[^2]

## Issue

### Why the "SSM Parameter Not Found" Error Occurs

The `SSM parameter /cdk-bootstrap/hnb659fds/version not found` error typically occurs when:

1. The CDK bootstrap process did not complete successfully, leaving the required SSM parameter unprovisioned.
2. The bootstrap stack was deleted or modified outside of the CDK, breaking the expected state.
3. Users are attempting to deploy to a different AWS account or region than where the bootstrap was performed.
4. Users use different qualifier to bootstrap but deploying resources without specify the required qualifier and context.

Let's discuss the 4th use case when a user deploys their CDK projects with a custom qualifier.

### Using a Custom Qualifier to Isolate Bootstrap Stacks

To avoid name clashes and deployment issues when working in the same AWS environment, users can bootstrap and deploy their CDK applications with custom qualifiers.

A qualifier is added to the physical IDs of resources in the bootstrap stack, allowing users to maintain multiple isolated bootstrap stacks in the same environment. This is particularly useful when running automated tests or deploying to different environments.[^3]

To bootstrap with a custom qualifier, run the following commands:

```bash
$ cdk bootstrap aws://<account-id>/<region> --qualifier <custom-qualifier>
```

Replacing `<custom-qualifier>` with a unique identifier of your choice. However, the user may run into the `SSM Parameter Not Found` issue when executing `cdk deploy` after bootstrapping with custom qualifier.

## Solution

The reason why deploy with a custom qualifier is because `cdk deploy` will still look for the default qualifier by default.[^4] To specify the custom qualifier for `cdk deploy`, user can use one of the commands below:[^5]

```bash
$ cdk deploy --no-previous-parameters

$ cdk deploy --context @aws-cdk/core:bootstrapQualifier=<custom-qualifier> --all
```

## Conclusion

If users encounter the `SSM parameter /cdk-bootstrap/hnb659fds/version not found` error, try the following steps:

1. Ensure the CDK bootstrap process completed successfully in the target environment by running `cdk bootstrap` with the appropriate qualifier.
2. If the bootstrap process fails, check the CloudFormation stack events of `CDKToolkit` for any errors and address them.
3. If the bootstrap stack was previously deleted or modified, you may need to recreate it using the `cdk bootstrap` command with a new qualifier.
4. When deploying your CDK application `cdk deploy`, always use the `--context @aws-cdk/core:bootstrapQualifier=<qualifier>` flag to reference the correct bootstrap stack.

By following these steps, the users can prevent and resolve the `SSM parameter /cdk-bootstrap/hnb659fds/version not found` error, ensuring a smooth and reliable CDK deployment process.

---

[^1]: [AWS CDK bootstrapping - AWS Cloud Development Kit (AWS CDK) v2](https://docs.aws.amazon.com/cdk/v2/guide/bootstrapping.html)
[^2]: [Bootstrap your environment for use with the AWS CDK - AWS Cloud Development Kit (AWS CDK) v2](https://docs.aws.amazon.com/cdk/v2/guide/bootstrapping-env.html)
[^3]: [Customize AWS CDK bootstrapping - AWS Cloud Development Kit (AWS CDK) v2](https://docs.aws.amazon.com/cdk/v2/guide/bootstrapping-customizing.html)
[^4]: [[cdk deploy] cdk deploy does not take into account the specific bootstrap qualifier · Issue #18453 · aws/aws-cdk](https://github.com/aws/aws-cdk/issues/18453)
[^5]: [amazon web services - AWS CDK keeps referencing old bootstrap qualifier even after re-bootstrapping with new bucket and qualifier - Stack Overflow](https://stackoverflow.com/questions/79033997/aws-cdk-keeps-referencing-old-bootstrap-qualifier-even-after-re-bootstrapping-wi)

