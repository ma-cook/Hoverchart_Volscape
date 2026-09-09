import {
  Position3D,
  GeometryType,
  Transform3D,
  Face,
  BoundingBox,
} from './geometry';

/**
 * Types of nodes in the AST
 */
export enum NodeType {
  FUNCTION = 'function',
  COMPONENT = 'component',
  STORE = 'store',
  SERVICE = 'service',
  LIBRARY = 'library',
  HOOK = 'hook',
  DATAPATH = 'datapath',
  MODULE = 'module',
  CLASS = 'class',
  INTERFACE = 'interface',
  VARIABLE = 'variable',
  CONSTANT = 'constant',
  // C4/architecture extensions
  PERSON = 'person',
  BOUNDARY = 'boundary',
  JUNCTION = 'junction',
}

/**
 * Types of connections between nodes
 */
export enum ConnectionType {
  DATA_FLOW = 'dataflow',
  CONTROL_FLOW = 'controlflow',
  INHERITANCE = 'inheritance',
  COMPOSITION = 'composition',
  DEPENDENCY = 'dependency',
  ASSOCIATION = 'association',
}

/**
 * Visual properties for styling nodes and connections
 */
export interface VisualProperties {
  color?: string;
  opacity?: number;
  wireframe?: boolean;
  material?: string;
  texture?: string;
  label?: {
    text: string;
    size: number;
    color: string;
    position: Position3D;
  };
}

/**
 * Core AST Node definition
 */
export interface ASTNode {
  id: string;
  type: NodeType;
  name: string;
  description?: string;
  geometry: GeometryType;
  transform: Transform3D;
  boundingBox: BoundingBox;
  faces: Face[];
  visual: VisualProperties;
  metadata: Record<string, any>;
  children: string[]; // IDs of child nodes
  parents: string[]; // IDs of parent nodes
}

/**
 * Connection between two nodes
 */
export interface ASTConnection {
  id: string;
  type: ConnectionType;
  source: {
    nodeId: string;
    faceId?: string;
    anchor?: Position3D;
  };
  target: {
    nodeId: string;
    faceId?: string;
    anchor?: Position3D;
  };
  visual: VisualProperties;
  metadata: Record<string, any>;
  waypoints?: Position3D[]; // Optional waypoints for curved connections
  flowPaths?: string[]; // IDs of flow paths this connection belongs to
  arrowStart?: boolean; // Render an arrowhead at the source end
  arrowEnd?: boolean; // Render an arrowhead at the target end
}

/**
 * A named data flow path through the application.
 * Tracks the ordered sequence of nodes that data travels through.
 */
export interface FlowPath {
  id: string;
  name: string;
  nodeSequence: string[]; // Ordered node IDs in the path
  connectionIds: string[]; // IDs of connections that form this path
  metadata?: Record<string, any>;
}

/**
 * Complete 3D AST Graph
 */
export interface AST3DGraph {
  id: string;
  name: string;
  description?: string;
  nodes: ASTNode[];
  connections: ASTConnection[];
  flowPaths: FlowPath[];
  metadata: Record<string, any>;
  bounds: BoundingBox;
}

/**
 * Configuration for AST generation
 */
export interface ASTConfig {
  layout: {
    algorithm: 'hierarchical' | 'force-directed' | 'circular' | 'grid';
    spacing: Position3D;
    layers: number;
  };
  geometry: {
    defaultScale: Position3D;
    nodeSpacing: number;
    connectionThickness: number;
  };
  visual: {
    theme: string;
    colorScheme: Record<NodeType, string>;
    defaultMaterial: string;
  };
}
