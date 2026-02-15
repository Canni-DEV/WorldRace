import type { DecorationPointKind } from '../data/Types';

export type DecorationPropKind = DecorationPointKind;

export interface DecorationKindInstancePayload {
  readonly kind: DecorationPropKind;
  readonly transforms: Float32Array;
}

export interface DecorationMeshStats {
  readonly sourcePointFeatures: number;
  readonly sourceAreaFeatures: number;
  readonly sampledAreaPoints: number;
  readonly rejectedByExclusion: number;
  readonly totalInstances: number;
  readonly treeCount: number;
  readonly lampCount: number;
  readonly signCount: number;
  readonly benchCount: number;
}

export interface DecorationTileMeshPayload {
  readonly tileKey: string;
  readonly tileCenter: {
    readonly east: number;
    readonly north: number;
  };
  readonly instancesByKind: readonly DecorationKindInstancePayload[];
  readonly stats: DecorationMeshStats;
}
