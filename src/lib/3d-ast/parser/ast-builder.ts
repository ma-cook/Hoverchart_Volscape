import { Graph } from '../models/graph';
import { Node } from '../models/node';
import { Connection } from '../models/connection';
import {
  ParsedGraph,
  ParsedNode,
  ParsedConnection,
  ParsedFlowPath,
  StyleDirective,
} from './mermaid-parser';
import { Config, DEFAULT_CONFIG } from '../types/config';
import { GeometryType } from '../types/geometry';

/**
 * Builds 3D AST Graph from parsed Merfolk syntax
 */
export class ASTBuilder {
  private config: Config;

  constructor(config: Partial<Config> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Build 3D AST Graph from parsed data
   */
  build(parsedGraph: ParsedGraph): Graph {
    const graphId = this.generateId();
    const graph = new Graph(
      graphId,
      parsedGraph.title || 'Untitled Graph',
      parsedGraph.description
    );

    // Add metadata
    if (parsedGraph.metadata) {
      graph.metadata = { ...parsedGraph.metadata };
    }

    // Create nodes
    const nodeMap = new Map<string, Node>();
    for (const parsedNode of parsedGraph.nodes) {
      const node = this.createNode(parsedNode);
      nodeMap.set(parsedNode.id, node);
      graph.addNode(node);
    }

    // Create connections
    for (const parsedConnection of parsedGraph.connections) {
      const connection = this.createConnection(parsedConnection, nodeMap);
      if (connection) {
        graph.addConnection(connection);
      }
    }

    // Register flow paths
    if (parsedGraph.flowPaths) {
      for (const parsedFlowPath of parsedGraph.flowPaths) {
        graph.addFlowPath({
          id: parsedFlowPath.id,
          name: parsedFlowPath.name,
          nodeSequence: parsedFlowPath.nodeSequence,
          connectionIds: parsedFlowPath.connectionIds,
          metadata: parsedFlowPath.metadata,
        });
      }
    }

    // Apply explicit containment (`Node[...] in <parentId>`). Runs after
    // applyNestedGrouping so explicit `in` membership is authoritative.
    this.applyExplicitParents(graph, parsedGraph);

    // Apply nested grouping logic for functions inside components
    this.applyNestedGrouping(graph, nodeMap);

    // Apply style / relstyle directives by node / connection type
    this.applyStyles(graph, parsedGraph.styles);

    // Carry alignment directives so the production layout pipeline can honour
    // `align row|column` after positioning.
    graph.metadata.alignments = parsedGraph.alignments || [];

    // Apply layout
    this.applyLayout(graph);

    // Update connection anchors after layout
    this.updateConnectionAnchors(graph);

    return graph;
  }

  /**
   * Wire explicit `in <parentId>` membership into the graph hierarchy.
   */
  private applyExplicitParents(
    graph: Graph,
    parsedGraph: ParsedGraph
  ): void {
    for (const parsedNode of parsedGraph.nodes) {
      if (!parsedNode.parentId) continue;
      const child = graph.getNode(parsedNode.id);
      const parent = graph.getNode(parsedNode.parentId);
      if (!child || !parent) {
        console.warn(
          `[ASTBuilder] '${parsedNode.id} in <${parsedNode.parentId}>': parent or child not found`
        );
        continue;
      }
      // Detach from any previously inferred/nested parent so `in` wins.
      if (child.parent && child.parent !== parsedNode.parentId) {
        const oldParent = graph.getNode(child.parent);
        oldParent?.removeChild(child.id);
      }
      child.setParent(parsedNode.parentId);
      parent.addChild(child.id);
      child.metadata.parentId = parsedNode.parentId;
      parent.metadata.isContainer = true;
    }
  }

  /**
   * Apply targeted `style`/`relstyle` directives by node / connection type.
   */
  private applyStyles(
    graph: Graph,
    directives: StyleDirective[] | undefined
  ): void {
    if (!directives || directives.length === 0) return;

    for (const directive of directives) {
      if (directive.kind === 'node') {
        const targets = directive.targets.map((t) => t.toLowerCase());
        for (const node of graph.nodes.values()) {
          if (targets.includes(node.type.toLowerCase())) {
            this.applyNodeStyle(node, directive.properties);
          }
        }
      } else {
        const targets = directive.targets.map((t) => t.toLowerCase());
        for (const conn of graph.connections.values()) {
          if (targets.includes(conn.type.toLowerCase())) {
            this.applyConnectionStyle(conn, directive.properties);
          }
        }
      }
    }
  }

  /**
   * Apply a style directive's properties to a node's visual + transform.
   */
  private applyNodeStyle(
    node: Node,
    properties: Record<string, any>
  ): void {
    if (properties.color) {
      node.visual.color = properties.color;
    }
    if (properties.opacity !== undefined) {
      node.visual.opacity = parseFloat(properties.opacity);
    }
    if (properties.scale) {
      const scale = this.parseScaleProp(properties.scale);
      if (scale) node.setScale(scale);
    }
  }

  /**
   * Apply a relstyle directive's properties to a connection's visual.
   */
  private applyConnectionStyle(
    connection: Connection,
    properties: Record<string, any>
  ): void {
    if (properties.color) {
      connection.visual.color = properties.color;
    }
    if (properties.opacity !== undefined) {
      connection.visual.opacity = parseFloat(properties.opacity);
    }
    if (properties.lineStyle) {
      connection.metadata.lineStyle = properties.lineStyle;
    }
  }

  /**
   * Parse a scale value that may be a number, "n[,n,n]", or [x,y,z] array.
   */
  private parseScaleProp(
    scaleData: any
  ): { x: number; y: number; z: number } | null {
    if (Array.isArray(scaleData) && scaleData.length >= 1) {
      const n = (v: any) => parseFloat(v) || 1;
      return {
        x: n(scaleData[0]),
        y: n(scaleData[1] ?? scaleData[0]),
        z: n(scaleData[2] ?? scaleData[0]),
      };
    }
    if (typeof scaleData === 'string' || typeof scaleData === 'number') {
      return this.parseScale(String(scaleData));
    }
    return null;
  }

  /**
   * Create a Node from parsed node data
   */
  private createNode(parsedNode: ParsedNode): Node {
    const node = new Node(
      parsedNode.id,
      parsedNode.type,
      parsedNode.name,
      parsedNode.geometry
    );

    // Set description
    if (parsedNode.description) {
      node.description = parsedNode.description;
    }

    // Apply custom properties
    if (parsedNode.properties) {
      node.metadata = { ...parsedNode.properties };

      // Apply visual properties if specified
      if (parsedNode.properties.color) {
        node.visual.color = parsedNode.properties.color;
      }
      if (parsedNode.properties.opacity) {
        node.visual.opacity = parseFloat(parsedNode.properties.opacity);
      }
      if (parsedNode.properties.scale) {
        const scale = this.parseScale(parsedNode.properties.scale);
        node.setScale(scale);
      }
      if (parsedNode.properties.position) {
        const position = this.parsePosition(parsedNode.properties.position);
        node.setPosition(position);
      }
    }

    // Apply theme colors
    if (!node.visual.color) {
      node.visual.color =
        this.config.visual.colors[parsedNode.type] || '#808080';
    }

    return node;
  }

  /**
   * Create a Connection from parsed connection data
   */
  private createConnection(
    parsedConnection: ParsedConnection,
    nodeMap: Map<string, Node>
  ): Connection | null {
    const sourceNode = nodeMap.get(parsedConnection.source.nodeId);
    const targetNode = nodeMap.get(parsedConnection.target.nodeId);
    if (!sourceNode || !targetNode) {
      // Skip invalid connections
      return null;
    }

    const connection = new Connection(
      parsedConnection.id,
      parsedConnection.type,
      {
        nodeId: parsedConnection.source.nodeId,
        faceId: parsedConnection.source.faceId,
      },
      {
        nodeId: parsedConnection.target.nodeId,
        faceId: parsedConnection.target.faceId,
      },
      parsedConnection.label // Pass the label to constructor
    );

    // Also set visual label if provided for backward compatibility
    if (parsedConnection.label) {
      connection.visual.label = {
        text: parsedConnection.label,
        size: 12,
        color: '#FFFFFF',
        position: { x: 0, y: 0, z: 0 },
      };
    }

    // Apply custom properties
    if (parsedConnection.properties) {
      connection.metadata = { ...parsedConnection.properties };
    }

    // Apply flow path tags
    if (parsedConnection.flowPaths) {
      for (const fp of parsedConnection.flowPaths) {
        connection.addFlowPath(fp);
      }
    }

    // Per-end arrow decorations (`<--`, `-->`, `<-->`, ...)
    connection.arrowStart = !!parsedConnection.arrowStart;
    connection.arrowEnd = !!parsedConnection.arrowEnd;

    return connection;
  }

  /**
   * Apply layout algorithm to position nodes
   */
  private applyLayout(graph: Graph): void {
    // Find nodes that already have custom positions (not at origin)
    const nodesWithCustomPositions = new Set<string>();
    for (const node of graph.nodes.values()) {
      const pos = node.transform.position;
      if (pos.x !== 0 || pos.y !== 0 || pos.z !== 0) {
        nodesWithCustomPositions.add(node.id);
      }
    }

    switch (this.config.layout.algorithm) {
      case 'hierarchical':
        this.applyHierarchicalLayout(graph, nodesWithCustomPositions);
        break;
      case 'force-directed':
        this.applyForceDirectedLayout(graph, nodesWithCustomPositions);
        break;
      case 'circular':
        this.applyCircularLayout(graph, nodesWithCustomPositions);
        break;
      case 'grid':
        this.applyGridLayout(graph, nodesWithCustomPositions);
        break;
      default:
        this.applyHierarchicalLayout(graph, nodesWithCustomPositions);
    }
  }

  /**
   * Apply hierarchical layout
   */
  private applyHierarchicalLayout(
    graph: Graph,
    nodesWithCustomPositions: Set<string> = new Set()
  ): void {
    const rootNodes = graph.getRootNodes();
    const spacing = this.config.layout.nodeSpacing;
    const layers = new Map<number, Node[]>();

    // Assign nodes to layers
    for (const root of rootNodes) {
      this.assignToLayers(graph, root, 0, layers, new Set());
    }

    // Position nodes by layer
    let maxY = 0;
    for (const [layer, nodes] of layers) {
      const y = layer * spacing * 2;
      maxY = Math.max(maxY, y);

      // Filter out nodes with custom positions
      const nodesToPosition = nodes.filter(
        (node) => !nodesWithCustomPositions.has(node.id)
      );

      if (nodesToPosition.length === 0) continue;

      // Ensure minimum spacing even with fewer nodes
      const effectiveSpacing = Math.max(spacing, 30.0);
      const totalWidth = (nodesToPosition.length - 1) * effectiveSpacing;
      const startX = -totalWidth / 2;

      nodesToPosition.forEach((node, index) => {
        const x = startX + index * effectiveSpacing;
        const z = 0;
        node.setPosition({ x, y, z });
      });
    }
  }

  /**
   * Apply force-directed layout (simplified)
   */
  private applyForceDirectedLayout(
    graph: Graph,
    nodesWithCustomPositions: Set<string> = new Set()
  ): void {
    const allNodes = Array.from(graph.nodes.values());
    const nodes = allNodes.filter(
      (node) => !nodesWithCustomPositions.has(node.id)
    );
    const spacing = Math.max(this.config.layout.nodeSpacing, 30.0);

    if (nodes.length === 0) return;

    // Initial random positioning with enforced spacing
    nodes.forEach((node, index) => {
      const angle = (index / nodes.length) * Math.PI * 2;
      const radius = Math.max(
        (spacing * nodes.length) / (Math.PI * 2),
        spacing * 2
      );

      node.setPosition({
        x: Math.cos(angle) * radius,
        y: 0,
        z: Math.sin(angle) * radius,
      });
    });

    // Simple force simulation with fixed parameters
    const iterations = 50;
    const repulsionStrength = 1.0;
    const attractionStrength = 0.1;
    const dampingFactor = 0.9;

    for (let i = 0; i < iterations; i++) {
      // Apply forces between nodes (only moveable nodes)
      for (let j = 0; j < nodes.length; j++) {
        for (let k = j + 1; k < nodes.length; k++) {
          this.applyRepulsiveForce(nodes[j], nodes[k], repulsionStrength);
        }
      }

      // Apply attractive forces for connected nodes
      for (const connection of graph.connections.values()) {
        const sourceNode = graph.getNode(connection.source.nodeId);
        const targetNode = graph.getNode(connection.target.nodeId);
        // Only apply forces if at least one node is moveable
        if (
          sourceNode &&
          targetNode &&
          (!nodesWithCustomPositions.has(sourceNode.id) ||
            !nodesWithCustomPositions.has(targetNode.id))
        ) {
          this.applyAttractiveForce(sourceNode, targetNode, attractionStrength);
        }
      }

      // Apply damping (only to moveable nodes)
      nodes.forEach((node) => {
        const pos = node.transform.position;
        node.setPosition({
          x: pos.x * dampingFactor,
          y: pos.y * dampingFactor,
          z: pos.z * dampingFactor,
        });
      });
    }
  }

  /**
   * Apply circular layout
   */
  private applyCircularLayout(
    graph: Graph,
    nodesWithCustomPositions: Set<string> = new Set()
  ): void {
    const allNodes = Array.from(graph.nodes.values());
    const nodes = allNodes.filter(
      (node) => !nodesWithCustomPositions.has(node.id)
    );
    const spacing = Math.max(this.config.layout.nodeSpacing, 30.0);

    if (nodes.length === 0) return;

    const radius = Math.max(
      (spacing * nodes.length) / (Math.PI * 2),
      spacing * 2
    );

    nodes.forEach((node, index) => {
      const angle = (index / nodes.length) * Math.PI * 2;
      node.setPosition({
        x: Math.cos(angle) * radius,
        y: 0,
        z: Math.sin(angle) * radius,
      });
    });
  }

  /**
   * Apply grid layout
   */
  private applyGridLayout(
    graph: Graph,
    nodesWithCustomPositions: Set<string> = new Set()
  ): void {
    const allNodes = Array.from(graph.nodes.values());
    const nodes = allNodes.filter(
      (node) => !nodesWithCustomPositions.has(node.id)
    );
    const spacing = Math.max(this.config.layout.nodeSpacing, 30.0);

    if (nodes.length === 0) return;

    const gridSize = Math.ceil(Math.sqrt(nodes.length));

    nodes.forEach((node, index) => {
      const row = Math.floor(index / gridSize);
      const col = index % gridSize;

      node.setPosition({
        x: (col - gridSize / 2) * spacing,
        y: 0,
        z: (row - gridSize / 2) * spacing,
      });
    });
  }

  /**
   * Recursively assign nodes to layers for hierarchical layout
   */
  private assignToLayers(
    graph: Graph,
    node: Node,
    layer: number,
    layers: Map<number, Node[]>,
    visited: Set<string>
  ): void {
    if (visited.has(node.id)) return;
    visited.add(node.id);

    if (!layers.has(layer)) {
      layers.set(layer, []);
    }
    layers.get(layer)!.push(node);

    // Process children
    for (const childId of node.children) {
      const child = graph.getNode(childId);
      if (child) {
        this.assignToLayers(graph, child, layer + 1, layers, visited);
      }
    }
  }

  /**
   * Apply repulsive force between two nodes
   */
  private applyRepulsiveForce(
    node1: Node,
    node2: Node,
    strength: number
  ): void {
    const pos1 = node1.transform.position;
    const pos2 = node2.transform.position;

    const dx = pos1.x - pos2.x;
    const dy = pos1.y - pos2.y;
    const dz = pos1.z - pos2.z;

    const distance = Math.sqrt(dx * dx + dy * dy + dz * dz) || 0.1;
    const force = strength / (distance * distance);

    const fx = (dx / distance) * force;
    const fy = (dy / distance) * force;
    const fz = (dz / distance) * force;

    node1.setPosition({
      x: pos1.x + fx,
      y: pos1.y + fy,
      z: pos1.z + fz,
    });

    node2.setPosition({
      x: pos2.x - fx,
      y: pos2.y - fy,
      z: pos2.z - fz,
    });
  }

  /**
   * Apply attractive force between two connected nodes
   */
  private applyAttractiveForce(
    node1: Node,
    node2: Node,
    strength: number
  ): void {
    const pos1 = node1.transform.position;
    const pos2 = node2.transform.position;

    const dx = pos2.x - pos1.x;
    const dy = pos2.y - pos1.y;
    const dz = pos2.z - pos1.z;

    const distance = Math.sqrt(dx * dx + dy * dy + dz * dz) || 0.1;
    const force = strength * distance;

    const fx = (dx / distance) * force * 0.1;
    const fy = (dy / distance) * force * 0.1;
    const fz = (dz / distance) * force * 0.1;

    node1.setPosition({
      x: pos1.x + fx,
      y: pos1.y + fy,
      z: pos1.z + fz,
    });

    node2.setPosition({
      x: pos2.x - fx,
      y: pos2.y - fy,
      z: pos2.z - fz,
    });
  }

  /**
   * Parse scale string to Position3D
   */
  private parseScale(scaleStr: string): { x: number; y: number; z: number } {
    const parts = scaleStr.split(',').map((s) => parseFloat(s.trim()));

    if (parts.length === 1) {
      return { x: parts[0], y: parts[0], z: parts[0] };
    } else if (parts.length === 3) {
      return { x: parts[0], y: parts[1], z: parts[2] };
    }

    return { x: 1, y: 1, z: 1 };
  }

  /**
   * Parse position string or array to Position3D
   */
  private parsePosition(positionData: any): {
    x: number;
    y: number;
    z: number;
  } {
    // Handle array format [x, y, z]
    if (Array.isArray(positionData) && positionData.length >= 3) {
      return {
        x: parseFloat(positionData[0]) || 0,
        y: parseFloat(positionData[1]) || 0,
        z: parseFloat(positionData[2]) || 0,
      };
    }

    // Handle string format "x,y,z"
    if (typeof positionData === 'string') {
      const parts = positionData.split(',').map((s) => parseFloat(s.trim()));
      if (parts.length >= 3) {
        return { x: parts[0] || 0, y: parts[1] || 0, z: parts[2] || 0 };
      }
    }

    return { x: 0, y: 0, z: 0 };
  }

  /**
   * Apply nested grouping logic for functions inside components
   */
  private applyNestedGrouping(graph: Graph, nodeMap: Map<string, Node>): void {
    const components = Array.from(nodeMap.values()).filter(
      (node) => node.geometry === GeometryType.CUBE && node.type === 'component'
    );
    const functions = Array.from(nodeMap.values()).filter(
      (node) =>
        node.geometry === GeometryType.DODECAHEDRON && node.type === 'function'
    );

    // Group functions by their logical parent component
    const componentGroups = new Map<
      string,
      { component: Node; functions: Node[] }
    >();

    components.forEach((component) => {
      const relatedFunctions = this.findRelatedFunctions(
        component,
        functions,
        graph
      );
      if (relatedFunctions.length > 0) {
        componentGroups.set(component.id, {
          component,
          functions: relatedFunctions,
        });
      }
    });

    // Apply nested positioning and sizing
    componentGroups.forEach((group) => {
      this.createNestedGroup(group.component, group.functions);
    });
  }

  /**
   * Find functions that should be nested inside a component
   */
  private findRelatedFunctions(
    component: Node,
    functions: Node[],
    graph: Graph
  ): Node[] {
    const related: Node[] = [];

    functions.forEach((func) => {
      // Check if function name suggests it belongs to this component
      const componentName = component.name.toLowerCase();
      const functionName = func.name.toLowerCase();

      // Strategy 1: Name-based matching (e.g., "UserService" contains "AuthFunction")
      if (
        functionName.includes(componentName.replace(/[^a-z]/g, '')) ||
        componentName.includes(functionName.replace(/[^a-z]/g, ''))
      ) {
        related.push(func);
        return;
      }

      // Strategy 2: Connection-based matching (functions connected to this component)
      const connections = Array.from(graph.connections.values());
      const isConnected = connections.some(
        (conn) =>
          (conn.source.nodeId === component.id &&
            conn.target.nodeId === func.id) ||
          (conn.source.nodeId === func.id &&
            conn.target.nodeId === component.id)
      );

      if (isConnected) {
        related.push(func);
      }
    });

    return related;
  }

  /**
   * Create nested positioning for functions inside a component
   */
  private createNestedGroup(component: Node, functions: Node[]): void {
    if (functions.length === 0) return;

    // Calculate container size based on function count
    const containerScale = this.calculateContainerSize(functions.length);
    component.setScale(containerScale);

    // Mark component as container using the new semantic properties
    const functionIds = functions.map((func) => func.id);
    component.setAsContainer(functionIds);

    // Position functions inside the component
    this.positionFunctionsInContainer(component, functions);

    // Set up parent-child relationships for functions
    functions.forEach((func) => {
      // Set semantic parent relationship
      func.setParent(component.id);

      // Legacy metadata for backward compatibility
      func.metadata.isNested = true;
      func.metadata.parentContainer = component.id;
    });
  }
  /**
   * Calculate container size based on the number of child functions
   */
  private calculateContainerSize(childCount: number): {
    x: number;
    y: number;
    z: number;
  } {
    const baseSize = 3; // Base scale for container
    const sizePerChild = 0.8; // Additional scale per child
    const scale = baseSize + childCount * sizePerChild;

    return { x: scale, y: scale, z: scale };
  }

  /**
   * Position functions inside their container component
   */
  private positionFunctionsInContainer(
    container: Node,
    functions: Node[]
  ): void {
    const containerPos = container.transform.position;
    const containerScale = container.transform.scale;

    // Create a grid layout inside the container
    const gridSize = Math.ceil(Math.sqrt(functions.length));
    const spacing =
      Math.min(containerScale.x, containerScale.y, containerScale.z) * 0.4; // 40% of container size

    functions.forEach((func, index) => {
      const row = Math.floor(index / gridSize);
      const col = index % gridSize;

      // Calculate relative position within container
      const offsetX = (col - (gridSize - 1) / 2) * spacing;
      const offsetY = 0.5; // Slightly elevated inside container
      const offsetZ = (row - (gridSize - 1) / 2) * spacing;

      // Set absolute position relative to container
      func.setPosition({
        x: containerPos.x + offsetX,
        y: containerPos.y + offsetY,
        z: containerPos.z + offsetZ,
      });

      // Scale down functions to fit inside container
      func.setScale({ x: 0.7, y: 0.7, z: 0.7 });
    });
  }

  /**
   * Update connection anchors after nodes have been positioned
   */
  private updateConnectionAnchors(graph: Graph): void {
    for (const connection of graph.connections.values()) {
      const sourceNode = graph.getNode(connection.source.nodeId);
      const targetNode = graph.getNode(connection.target.nodeId);

      if (sourceNode && targetNode) {
        // Update source anchor
        if (connection.source.faceId) {
          const sourceFace = sourceNode.getFace(connection.source.faceId);
          if (sourceFace) {
            connection.source.anchor = sourceFace.center;
          }
        } else {
          connection.source.anchor = sourceNode.transform.position;
        }

        // Update target anchor
        if (connection.target.faceId) {
          const targetFace = targetNode.getFace(connection.target.faceId);
          if (targetFace) {
            connection.target.anchor = targetFace.center;
          }
        } else {
          connection.target.anchor = targetNode.transform.position;
        }
      }
    }
  }

  /**
   * Generate unique ID
   */
  private generateId(): string {
    return `graph_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
  }
}
