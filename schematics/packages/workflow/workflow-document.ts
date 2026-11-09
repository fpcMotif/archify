import type { Point, Relation } from '../geometry/geometry.ts';
import type { Translations } from '../i18n/i18n.ts';
import type { LegendConfig } from '../svg/legend.ts';
import type { InfoCard } from '../svg/utils.ts';

export interface WorkflowMeta {
  title: string;
  output?: string;
  subtitle?: string;
  locale?: string;
  translations?: Translations;
  animation?: 'trace' | 'none';
  visual_preset?: string;
  quality_profile?: string;
  repository?: unknown;
  views?: unknown;
  legend?: LegendConfig;
  viewBox?: number[];
}

export interface WorkflowLane {
  id: string;
  label: string;
  variant?: 'normal' | 'exception';
}

export interface WorkflowPhase {
  id: string;
  label: string;
  fromCol: number;
  toCol: number;
  variant?: string;
}

export interface WorkflowGroup {
  id: string;
  label: string;
  lane: string;
  fromCol: number;
  toCol: number;
  variant?: string;
}

export interface WorkflowSemanticRelation {
  from: string;
  to: string;
}

export interface WorkflowSemanticChecks {
  allowedRoots?: string[];
  allowedTerminals?: string[];
  requiredEdges?: WorkflowSemanticRelation[];
  requiredPaths?: WorkflowSemanticRelation[];
}

export interface WorkflowNode {
  id: string;
  lane: string;
  col: number;
  type: string;
  label: string;
  sublabel?: string;
  tag?: string;
  icon?: string;
  brand?: unknown;
  sources?: readonly unknown[];
  width?: number;
  height?: number;
  yOffset?: number;
}

export interface WorkflowEdge extends Relation {
  from: string;
  to: string;
  label?: string;
  variant?: string;
  role?: string;
  fromSide?: string;
  toSide?: string;
  route?: string;
  via?: Point[];
  labelAt?: Point;
  labelDx?: number;
  labelDy?: number;
  labelSegment?: number;
  channelX?: number;
  channelY?: number;
  bias?: number;
  width?: number;
}

export type WorkflowEdgeField = Exclude<keyof WorkflowEdge, 'from' | 'to'>;

export interface WorkflowDocument {
  schema_version: 1 | 2;
  diagram_type: 'workflow';
  meta: WorkflowMeta;
  lanes: WorkflowLane[];
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  phases?: WorkflowPhase[];
  groups?: WorkflowGroup[];
  mainPath?: string[];
  semanticChecks?: WorkflowSemanticChecks;
  cards?: InfoCard[];
  [key: symbol]: unknown;
}
