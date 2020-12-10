import {Component} from "./Component";
import {CloudFormationOutput, CloudFormationOutputs, Stack} from '../Stack';
import {cidrSubnets, cidrVpc, getZoneId} from '../Cidr';

export class Vpc extends Component {
    private readonly props: Record<string, any>;

    private readonly vpcResourceId = this.formatCloudFormationId('Vpc');
    private readonly internetGatewayResourceId = this.formatCloudFormationId('VpcInternetGateway');
    private readonly appSecurityGroupResourceId = this.formatCloudFormationId('AppSecurityGroup');
    private readonly dbSecurityGroupResourceId = this.formatCloudFormationId('DBSecurityGroup');

    constructor(stack: Stack, props: Record<string, any> | null) {
        super(stack);
        this.props = props ? props : {};
    }

    compile(): Record<string, any> {
        const availabilityZones = this.stack.availabilityZones();

        return {
            [this.vpcResourceId]: {
                Type: 'AWS::EC2::VPC',
                Properties: {
                    CidrBlock: cidrVpc,
                    // TODO why?
                    EnableDnsSupport: true,
                    EnableDnsHostnames: true,
                    Tags: [
                        this.tag('Name', this.stackName),
                    ],
                },
            },
            [this.internetGatewayResourceId]: {
                Type: 'AWS::EC2::InternetGateway',
                Properties: {
                    Tags: [
                        this.tag('Name', `${this.stackName}-igw`),
                        // ?
                        this.tag('Network', 'Public'),
                    ]
                }
            },
            [this.formatCloudFormationId('VpcInternetGatewayAttachment')]: {
                Type: 'AWS::EC2::VPCGatewayAttachment',
                Properties: {
                    InternetGatewayId: this.fnRef(this.formatCloudFormationId('VpcInternetGateway')),
                    VpcId: this.fnRef(this.vpcResourceId),
                },
            },

            ...this.compileSubnets('Public', availabilityZones),

            ...this.compileSubnets('Private', availabilityZones),

            // What is this?
            [this.formatCloudFormationId('DefaultSecurityGroupEgress')]: {
                Type: 'AWS::EC2::SecurityGroupEgress',
                Properties: {
                    IpProtocol: '-1',
                    DestinationSecurityGroupId: this.fnGetAtt(this.vpcResourceId, 'DefaultSecurityGroup'),
                    GroupId: this.fnGetAtt(this.vpcResourceId, 'DefaultSecurityGroup'),
                }
            },

            [this.appSecurityGroupResourceId]: {
                Type: 'AWS::EC2::SecurityGroup',
                Properties: {
                    GroupDescription: 'Application security group',
                    VpcId: this.fnRef(this.vpcResourceId),
                    SecurityGroupEgress: [
                        {
                            Description: 'permit HTTP outbound',
                            IpProtocol: 'tcp',
                            FromPort: 80,
                            ToPort: 80,
                            CidrIp: '0.0.0.0/0',
                        },
                        {
                            Description: 'Allow HTTPS outbound',
                            IpProtocol: 'tcp',
                            FromPort: 443,
                            ToPort: 443,
                            CidrIp: '0.0.0.0/0',
                        },
                    ],
                    SecurityGroupIngress: [
                        {
                            Description: 'Allow HTTPS inbound',
                            IpProtocol: 'tcp',
                            FromPort: 443,
                            ToPort: 443,
                            CidrIp: '0.0.0.0/0',
                        }
                    ],
                    Tags: [
                        this.tag('Name', `${this.stackName}-app-sg`),
                    ]
                }
            },
            [this.formatCloudFormationId('AppSecurityGroupEgress')]: {
                Type: 'AWS::EC2::SecurityGroupEgress',
                Properties: {
                    Description: 'Allow Lambda to access MySQL in the DBSecurityGroup',
                    GroupId: this.fnRef(this.appSecurityGroupResourceId),
                    IpProtocol: 'tcp',
                    FromPort: 3306,
                    ToPort: 3306,
                    DestinationSecurityGroupId: this.fnRef(this.dbSecurityGroupResourceId),
                }
            },

            [this.dbSecurityGroupResourceId]: {
                Type: 'AWS::EC2::SecurityGroup',
                Properties: {
                    GroupDescription: 'Database security group',
                    VpcId: this.fnRef(this.vpcResourceId),
                    SecurityGroupIngress: [
                        {
                            Description: 'Allow inbound MySQL access from Lambda',
                            IpProtocol: 'tcp',
                            FromPort: 3306,
                            ToPort: 3306,
                            SourceSecurityGroupId: this.fnRef(this.appSecurityGroupResourceId),
                        }
                    ],
                    Tags: [
                        this.tag('Name', `${this.stackName}-db-sg`),
                    ]
                }
            },

            [this.formatCloudFormationId('DHCPOptions')]: {
                Type: 'AWS::EC2::DHCPOptions',
                Properties: {
                    DomainName: `${this.stack.region}.compute.internal`,
                    DomainNameServers: ['AmazonProvidedDNS'],
                    Tags: [
                        this.tag('Name', `${this.stackName}-DHCPOptionsSet`),
                    ],
                }
            },
            [this.formatCloudFormationId('DHCPOptionsAssociation')]: {
                Type: 'AWS::EC2::VPCDHCPOptionsAssociation',
                Properties: {
                    VpcId: this.fnRef(this.vpcResourceId),
                    DhcpOptionsId: this.fnRef(this.formatCloudFormationId('DHCPOptions')),
                }
            },
        };
    }

    outputs() {
        const zones = this.stack.availabilityZones();
        return {
            // VPC ID
            [this.vpcResourceId + 'Id']: {
                Description: 'VPC ID',
                Value: this.fnRef(this.vpcResourceId),
            },
            // App security group ID -> to be used by the serverless app
            [this.appSecurityGroupResourceId + 'Id']: {
                Description: 'VPC ID',
                Value: this.fnRef(this.appSecurityGroupResourceId),
            },
            // Public subnet IDs -> to be used by the serverless app
            ...Object.assign({}, ...zones.map((zone): CloudFormationOutputs => {
                const subnetResourceId = this.formatCloudFormationId(`SubnetPublic-${zone}`);
                return {
                    [subnetResourceId + 'Id']: {
                        Description: `Public subnet ID for zone ${zone}`,
                        Value: this.fnRef(subnetResourceId),
                    },
                };
            })),
        };
    }

    async permissions() {
        return [];
    }

    async envVariables() {
        return {};
    }

    async details() {
        const zones = this.stack.availabilityZones();
        return {
            securityGroupIds: [
                await this.stack.getOutput(this.appSecurityGroupResourceId + 'Id'),
            ],
            subnetIds: await Promise.all(zones.map(async zone => {
                const subnetResourceId = this.formatCloudFormationId(`SubnetPublic-${zone}`);
                return await this.stack.getOutput(subnetResourceId + 'Id');
            })),
        };
    }

    compileSubnets(subnetName: 'Public'|'Private', availabilityZones: string[]) {
        const subnets = availabilityZones.map(zone => this.compileSubnet(subnetName, zone));
        // Merge all into a single object
        return Object.assign({}, ...subnets);
    }

    compileSubnet(type: 'Public'|'Private', zone: string) {
        const subnetResourceId = this.formatCloudFormationId(`Subnet${type}-${zone}`);
        const routeTableResourceId = this.formatCloudFormationId(`RouteTable${type}-${zone}`);

        // If public subnet, we route the internet traffic to the internet gateway
        let publicRoute = {};
        if (type === 'Public') {
            publicRoute = {
                [this.formatCloudFormationId(`Route${type}-${zone}`)]: {
                    Type: 'AWS::EC2::Route',
                    Properties: {
                        DestinationCidrBlock: '0.0.0.0/0',
                        RouteTableId: this.fnRef(routeTableResourceId),
                        GatewayId: this.fnRef(this.internetGatewayResourceId),
                    },
                    DependsOn: [
                        this.formatCloudFormationId('VpcInternetGatewayAttachment'),
                    ],
                },
            };
        }

        return {
            [subnetResourceId]: {
                Type: 'AWS::EC2::Subnet',
                Properties: {
                    VpcId: this.fnRef(this.vpcResourceId),
                    AvailabilityZone: zone,
                    CidrBlock: cidrSubnets[getZoneId(zone)][type],
                    Tags: [
                        this.tag('Name', `${this.stackName}-${type}-${zone}`.toLowerCase()),
                        // ?
                        this.tag('Network', type),
                    ],
                },
            },
            [routeTableResourceId]: {
                Type: 'AWS::EC2::RouteTable',
                Properties: {
                    VpcId: this.fnRef(this.vpcResourceId),
                    Tags: [
                        this.tag('Name', `${this.stackName}-${type}-${zone}`.toLowerCase()),
                        // ?
                        this.tag('Network', type),
                    ],
                },
            },
            [this.formatCloudFormationId(`RouteTableAssociation${type}-${zone}`)]: {
                Type: 'AWS::EC2::SubnetRouteTableAssociation',
                Properties: {
                    SubnetId: this.fnRef(subnetResourceId),
                    RouteTableId: this.fnRef(routeTableResourceId),
                },
            },
            ...publicRoute,
        };
    }
}
