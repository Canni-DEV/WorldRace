import { TopologyBuilder } from './TopologyBuilder';
import type { RouteWeightingProfile, TileOSMData } from '../data/Types';
import type {
  TileRoadTopology,
  TileRoadTopologyLocal,
  TopologyEdge,
  TopologyNode,
  TopologyNodeLocal,
} from './TopologyTypes';

interface TopologyRegistryConfig {
  readonly routeWeightingProfile: RouteWeightingProfile;
}

export class TopologyRegistry {
  private readonly topologyBuilder: TopologyBuilder;
  private readonly topologyByTileKey = new Map<string, TileRoadTopology>();
  private readonly globalNodeIdByKey = new Map<string, string>();
  private readonly globalNodeRefCount = new Map<string, number>();
  private globalNodeCounter = 0;

  public constructor(config: Partial<TopologyRegistryConfig> = {}) {
    this.topologyBuilder = new TopologyBuilder({
      routeWeightingProfile: config.routeWeightingProfile,
    });
  }

  public upsertTile(tileData: TileOSMData): TileRoadTopology {
    const previous = this.topologyByTileKey.get(tileData.tileKey);
    if (previous !== undefined) {
      this.releaseTile(previous);
    }

    const localTopology = this.topologyBuilder.build({ tileData });
    const stitchedTopology = this.assignGlobalNodes(localTopology);
    this.topologyByTileKey.set(tileData.tileKey, stitchedTopology);
    return stitchedTopology;
  }

  public getTileTopology(tileKey: string): TileRoadTopology | undefined {
    return this.topologyByTileKey.get(tileKey);
  }

  public getLoadedTileCount(): number {
    return this.topologyByTileKey.size;
  }

  public removeTile(tileKey: string): void {
    const existing = this.topologyByTileKey.get(tileKey);
    if (existing === undefined) {
      return;
    }

    this.topologyByTileKey.delete(tileKey);
    this.releaseTile(existing);
  }

  private assignGlobalNodes(localTopology: TileRoadTopologyLocal): TileRoadTopology {
    const nodeByKey = new Map<string, TopologyNode>();
    let stitchedNodes = 0;

    for (const localNode of localTopology.nodes) {
      const assignment = this.assignGlobalNode(localNode);
      if (assignment.wasStitched) {
        stitchedNodes += 1;
      }

      nodeByKey.set(localNode.nodeKey, {
        globalNodeId: assignment.globalNodeId,
        nodeKey: localNode.nodeKey,
        east: localNode.east,
        north: localNode.north,
      });
    }

    const edges: TopologyEdge[] = localTopology.edges.map((edge) => {
      const fromNode = nodeByKey.get(edge.fromNodeKey);
      const toNode = nodeByKey.get(edge.toNodeKey);
      if (fromNode === undefined || toNode === undefined) {
        throw new Error(`Topology edge references unknown node key: ${edge.edgeId}`);
      }

      return {
        edgeId: edge.edgeId,
        roadId: edge.roadId,
        fromNodeId: fromNode.globalNodeId,
        toNodeId: toNode.globalNodeId,
        fromNodeKey: edge.fromNodeKey,
        toNodeKey: edge.toNodeKey,
        canonicalPoints: edge.canonicalPoints,
        visualPoints: edge.visualPoints,
        properties: edge.properties,
        routing: edge.routing,
        lengthMeters: edge.lengthMeters,
      };
    });

    return {
      tileKey: localTopology.tileKey,
      nodes: [...nodeByKey.values()],
      edges,
      stats: {
        ...localTopology.stats,
        stitchedNodes,
      },
    };
  }

  private assignGlobalNode(node: TopologyNodeLocal): {
    readonly globalNodeId: string;
    readonly wasStitched: boolean;
  } {
    const existingNodeId = this.globalNodeIdByKey.get(node.nodeKey);
    if (existingNodeId !== undefined) {
      const currentRefCount = this.globalNodeRefCount.get(existingNodeId) ?? 0;
      this.globalNodeRefCount.set(existingNodeId, currentRefCount + 1);
      return {
        globalNodeId: existingNodeId,
        wasStitched: currentRefCount > 0,
      };
    }

    const nodeId = `node:${this.globalNodeCounter}`;
    this.globalNodeCounter += 1;
    this.globalNodeIdByKey.set(node.nodeKey, nodeId);
    this.globalNodeRefCount.set(nodeId, 1);

    return {
      globalNodeId: nodeId,
      wasStitched: false,
    };
  }

  private releaseTile(topology: TileRoadTopology): void {
    for (const node of topology.nodes) {
      const currentRefCount = this.globalNodeRefCount.get(node.globalNodeId);
      if (currentRefCount === undefined) {
        continue;
      }

      if (currentRefCount <= 1) {
        this.globalNodeRefCount.delete(node.globalNodeId);
        this.globalNodeIdByKey.delete(node.nodeKey);
        continue;
      }

      this.globalNodeRefCount.set(node.globalNodeId, currentRefCount - 1);
    }
  }
}
