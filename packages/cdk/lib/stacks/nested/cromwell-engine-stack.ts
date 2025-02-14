import { NestedStackProps, RemovalPolicy } from "monocdk";
import { IVpc } from "monocdk/aws-ec2";
import { CloudMapOptions, FargateTaskDefinition, LogDriver } from "monocdk/aws-ecs";
import { Construct } from "constructs";
import { ApiProxy, SecureService } from "../../constructs";
import { PrivateDnsNamespace } from "monocdk/aws-servicediscovery";
import { IRole, Role, ServicePrincipal } from "monocdk/aws-iam";
import { createEcrImage, renderServiceWithContainer, renderServiceWithTaskDefinition } from "../../util";
import { APP_NAME } from "../../constants";
import { Bucket } from "monocdk/aws-s3";
import { FileSystem } from "monocdk/aws-efs";
import { EngineOptions, ServiceContainer } from "../../types";
import { ILogGroup } from "monocdk/lib/aws-logs/lib/log-group";
import { LogGroup } from "monocdk/aws-logs";
import { EngineOutputs, NestedEngineStack } from "./nested-engine-stack";

export interface CromwellEngineStackProps extends EngineOptions, NestedStackProps {}

export class CromwellEngineStack extends NestedEngineStack {
  public readonly engine: SecureService;
  public readonly adapter: SecureService;
  public readonly taskRole: IRole;
  public readonly apiProxy: ApiProxy;
  public readonly adapterLogGroup: ILogGroup;
  public readonly engineLogGroup: ILogGroup;

  constructor(scope: Construct, id: string, props: CromwellEngineStackProps) {
    super(scope, id, props);

    const params = props.contextParameters;
    const engineContainer = params.getEngineContainer(props.jobQueue.jobQueueArn);
    this.taskRole = new Role(this, "TaskRole", { assumedBy: new ServicePrincipal("ecs-tasks.amazonaws.com"), ...props.policyOptions });
    const namespace = new PrivateDnsNamespace(this, "EngineNamespace", {
      name: `${params.projectName}-${params.contextName}-${params.userId}.${APP_NAME}.amazon.com`,
      vpc: props.vpc,
    });
    const cloudMapOptions: CloudMapOptions = {
      name: engineContainer.serviceName,
      cloudMapNamespace: namespace,
    };
    // TODO: Move log group creation into service construct and make it a property
    this.engineLogGroup = new LogGroup(this, "EngineLogGroup");
    this.engine = this.getEngineServiceDefinition(props.vpc, engineContainer, cloudMapOptions, this.engineLogGroup);
    this.adapterLogGroup = new LogGroup(this, "AdapterLogGroup");
    this.adapter = renderServiceWithContainer(this, "Adapter", params.getAdapterContainer(), props.vpc, this.taskRole, this.adapterLogGroup);

    this.apiProxy = new ApiProxy(this, {
      apiName: `${params.projectName}${params.contextName}${engineContainer.serviceName}ApiProxy`,
      loadBalancer: this.adapter.loadBalancer,
      allowedAccountIds: [this.account],
    });

    const outputBucket = Bucket.fromBucketName(this, "OutputBucket", params.outputBucketName);
    outputBucket.grantReadWrite(this.taskRole);
  }

  protected getOutputs(): EngineOutputs {
    return {
      accessLogGroup: this.apiProxy.accessLogGroup,
      adapterLogGroup: this.adapterLogGroup,
      engineLogGroup: this.engineLogGroup,
      wesUrl: this.apiProxy.restApi.url,
    };
  }

  private getEngineServiceDefinition(vpc: IVpc, serviceContainer: ServiceContainer, cloudMapOptions: CloudMapOptions, logGroup: ILogGroup) {
    const id = "Engine";
    const fileSystem = new FileSystem(this, "EngineFileSystem", {
      vpc,
      encrypted: true,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const definition = new FargateTaskDefinition(this, "EngineTaskDef", {
      taskRole: this.taskRole,
      cpu: serviceContainer.cpu,
      memoryLimitMiB: serviceContainer.memoryLimitMiB,
    });

    const volumeName = "cromwell-executions";
    definition.addVolume({
      name: volumeName,
      efsVolumeConfiguration: {
        fileSystemId: fileSystem.fileSystemId,
      },
    });

    const container = definition.addContainer(serviceContainer.serviceName, {
      cpu: serviceContainer.cpu,
      memoryLimitMiB: serviceContainer.memoryLimitMiB,
      environment: serviceContainer.environment,
      containerName: serviceContainer.serviceName,
      image: createEcrImage(this, serviceContainer.imageConfig.designation),
      logging: LogDriver.awsLogs({ logGroup, streamPrefix: id }),
      portMappings: serviceContainer.containerPort ? [{ containerPort: serviceContainer.containerPort }] : [],
    });

    container.addMountPoints({
      containerPath: "/cromwell-executions",
      readOnly: false,
      sourceVolume: volumeName,
    });
    const engine = renderServiceWithTaskDefinition(this, id, serviceContainer, definition, vpc, cloudMapOptions);

    fileSystem.connections.allowDefaultPortFrom(engine.service);
    return engine;
  }
}
