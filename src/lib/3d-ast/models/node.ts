import {
  Position3D,
  GeometryType,
  Transform3D,
  Face,
  BoundingBox,
} from '../types/geometry';
import { NodeType, VisualProperties } from '../types/ast';

/**
 * 3D AST Node implementation
 */
export class Node {
  public id: string;
  public type: NodeType;
  public name: string;
  public description?: string;
  public geometry: GeometryType;
  public transform: Transform3D;
  public boundingBox: BoundingBox;
  public faces: Face[];
  public visual: VisualProperties;
  public metadata: Record<string, any>;
  public children: string[] = [];
  public parents: string[] = [];
  public parent?: string; // Primary parent for containment relationships
  public isContainer: boolean = false; // Flag indicating this node contains other nodes

  constructor(
    id: string,
    type: NodeType,
    name: string,
    geometry: GeometryType = GeometryType.CUBE
  ) {
    this.id = id;
    this.type = type;
    this.name = name;
    this.geometry = geometry;
    this.transform = {
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
    };
    this.boundingBox = this.calculateBoundingBox();
    this.faces = this.generateFaces();
    this.visual = {
      color: this.getDefaultColor(),
      opacity: 0.9,
      wireframe: false,
    };
    this.metadata = {};
  }

  /**
   * Add a child node
   */
  addChild(childId: string): void {
    if (!this.children.includes(childId)) {
      this.children.push(childId);
    }
  }

  /**
   * Add a parent node
   */
  addParent(parentId: string): void {
    if (!this.parents.includes(parentId)) {
      this.parents.push(parentId);
    }
  }

  /**
   * Remove a child node
   */
  removeChild(childId: string): void {
    this.children = this.children.filter((id) => id !== childId);
  }

  /**
   * Remove a parent node
   */
  removeParent(parentId: string): void {
    this.parents = this.parents.filter((id) => id !== parentId);
  }

  /**
   * Set the primary parent for containment relationships
   */
  setParent(parentId: string): void {
    this.parent = parentId;
    this.addParent(parentId);
  }

  /**
   * Remove the primary parent
   */
  removeParentContainer(): void {
    this.parent = undefined;
  }

  /**
   * Mark this node as a container
   */
  setAsContainer(childIds: string[] = []): void {
    this.isContainer = true;
    this.metadata.isContainer = true;
    this.metadata.childCount = childIds.length;

    // Add children if provided
    childIds.forEach((childId) => this.addChild(childId));
  }

  /**
   * Check if this node is contained within another node
   */
  isContained(): boolean {
    return this.parent !== undefined || this.metadata.isNested === true;
  }

  /**
   * Get the container node ID if this node is contained
   */
  getContainerNodeId(): string | undefined {
    return this.parent || this.metadata.parentContainer;
  }

  /**
   * Update the node's position
   */
  setPosition(position: Position3D): void {
    this.transform.position = { ...position };
    this.boundingBox = this.calculateBoundingBox();
    this.updateFacePositions();
  }

  /**
   * Update the node's scale
   */
  setScale(scale: Position3D): void {
    this.transform.scale = { ...scale };
    this.boundingBox = this.calculateBoundingBox();
    this.updateFacePositions();
  }

  /**
   * Get a face by ID
   */
  getFace(faceId: string): Face | undefined {
    return this.faces.find((face) => face.id === faceId);
  }

  /**
   * Get all available connection points (face centers)
   */
  getConnectionPoints(): Position3D[] {
    return this.faces.map((face) => face.center);
  }

  /**
   * Calculate bounding box based on geometry and transform
   */
  private calculateBoundingBox(): BoundingBox {
    const { position, scale } = this.transform;
    const halfSize = {
      x: scale.x / 2,
      y: scale.y / 2,
      z: scale.z / 2,
    };

    return {
      min: {
        x: position.x - halfSize.x,
        y: position.y - halfSize.y,
        z: position.z - halfSize.z,
      },
      max: {
        x: position.x + halfSize.x,
        y: position.y + halfSize.y,
        z: position.z + halfSize.z,
      },
      center: { ...position },
      size: { ...scale },
    };
  }

  /**
   * Generate faces based on geometry type
   */
  private generateFaces(): Face[] {
    const { position, scale } = this.transform;

    switch (this.geometry) {
      case GeometryType.CUBE:
        return this.generateCubeFaces(position, scale);
      case GeometryType.TETRAHEDRON:
        return this.generateTetrahedronFaces(position, scale);
      case GeometryType.DODECAHEDRON:
        return this.generateDodecahedronFaces(position, scale);
      case GeometryType.SPHERE:
        // Spheres connect from their centre — a single implicit "surface" face.
        return [
          {
            id: 'center',
            normal: { x: 0, y: 0, z: 1 },
            center: { ...position },
            vertices: [],
          },
        ];
      default:
        return this.generateCubeFaces(position, scale);
    }
  }

  /**
   * Generate faces for a cube
   */
  private generateCubeFaces(position: Position3D, scale: Position3D): Face[] {
    const faces: Face[] = [];
    const halfScale = { x: scale.x / 2, y: scale.y / 2, z: scale.z / 2 };

    // Front face
    faces.push({
      id: 'front',
      normal: { x: 0, y: 0, z: 1 },
      center: { x: position.x, y: position.y, z: position.z + halfScale.z },
      vertices: [
        {
          x: position.x - halfScale.x,
          y: position.y - halfScale.y,
          z: position.z + halfScale.z,
        },
        {
          x: position.x + halfScale.x,
          y: position.y - halfScale.y,
          z: position.z + halfScale.z,
        },
        {
          x: position.x + halfScale.x,
          y: position.y + halfScale.y,
          z: position.z + halfScale.z,
        },
        {
          x: position.x - halfScale.x,
          y: position.y + halfScale.y,
          z: position.z + halfScale.z,
        },
      ],
    });

    // Back face
    faces.push({
      id: 'back',
      normal: { x: 0, y: 0, z: -1 },
      center: { x: position.x, y: position.y, z: position.z - halfScale.z },
      vertices: [
        {
          x: position.x + halfScale.x,
          y: position.y - halfScale.y,
          z: position.z - halfScale.z,
        },
        {
          x: position.x - halfScale.x,
          y: position.y - halfScale.y,
          z: position.z - halfScale.z,
        },
        {
          x: position.x - halfScale.x,
          y: position.y + halfScale.y,
          z: position.z - halfScale.z,
        },
        {
          x: position.x + halfScale.x,
          y: position.y + halfScale.y,
          z: position.z - halfScale.z,
        },
      ],
    });

    // Add top, bottom, left, right faces...
    // (Similar pattern for other faces)

    return faces;
  }

  /**
   * Generate faces for a dodecahedron (simplified - 12 pentagonal faces)
   */
  private generateDodecahedronFaces(
    position: Position3D,
    scale: Position3D
  ): Face[] {
    // This is a simplified implementation
    // In a real implementation, you'd calculate the proper pentagonal face positions
    const faces: Face[] = [];
    const radius = Math.max(scale.x, scale.y, scale.z) / 2;

    for (let i = 0; i < 12; i++) {
      const angle = (i * Math.PI * 2) / 12;
      faces.push({
        id: `face_${i}`,
        normal: { x: Math.cos(angle), y: Math.sin(angle), z: 0 },
        center: {
          x: position.x + Math.cos(angle) * radius,
          y: position.y + Math.sin(angle) * radius,
          z: position.z,
        },
        vertices: [], // Would calculate pentagon vertices here
      });
    }

    return faces;
  }

  /**
   * Generate faces for a tetrahedron
   */
  private generateTetrahedronFaces(
    position: Position3D,
    scale: Position3D
  ): Face[] {
    const faces: Face[] = [];
    const radius = Math.max(scale.x, scale.y, scale.z) / 2;

    // Tetrahedron vertices (4 vertices forming a triangular pyramid)
    const vertices = [
      { x: 0, y: radius, z: 0 }, // Top vertex
      { x: -radius * 0.816, y: -radius * 0.333, z: -radius * 0.471 }, // Base vertex 1
      { x: radius * 0.816, y: -radius * 0.333, z: -radius * 0.471 }, // Base vertex 2
      { x: 0, y: -radius * 0.333, z: radius * 0.943 }, // Base vertex 3
    ];

    // Offset vertices by position
    const offsetVertices = vertices.map((v) => ({
      x: v.x + position.x,
      y: v.y + position.y,
      z: v.z + position.z,
    }));

    // Generate 4 triangular faces
    const faceIndices = [
      [0, 1, 2], // Face 1: top-base1-base2
      [0, 2, 3], // Face 2: top-base2-base3
      [0, 3, 1], // Face 3: top-base3-base1
      [1, 3, 2], // Face 4: base1-base3-base2 (bottom face)
    ];

    faceIndices.forEach((indices, faceIndex) => {
      const faceVertices = indices.map((i) => offsetVertices[i]);

      // Calculate face center
      const center = {
        x: faceVertices.reduce((sum, v) => sum + v.x, 0) / 3,
        y: faceVertices.reduce((sum, v) => sum + v.y, 0) / 3,
        z: faceVertices.reduce((sum, v) => sum + v.z, 0) / 3,
      };

      // Calculate face normal (simplified)
      const v1 = {
        x: faceVertices[1].x - faceVertices[0].x,
        y: faceVertices[1].y - faceVertices[0].y,
        z: faceVertices[1].z - faceVertices[0].z,
      };
      const v2 = {
        x: faceVertices[2].x - faceVertices[0].x,
        y: faceVertices[2].y - faceVertices[0].y,
        z: faceVertices[2].z - faceVertices[0].z,
      };

      // Cross product for normal
      const normal = {
        x: v1.y * v2.z - v1.z * v2.y,
        y: v1.z * v2.x - v1.x * v2.z,
        z: v1.x * v2.y - v1.y * v2.x,
      };

      // Normalize
      const length = Math.sqrt(
        normal.x * normal.x + normal.y * normal.y + normal.z * normal.z
      );
      if (length > 0) {
        normal.x /= length;
        normal.y /= length;
        normal.z /= length;
      }

      faces.push({
        id: `face_${faceIndex}`,
        normal,
        center,
        vertices: faceVertices,
      });
    });

    return faces;
  }

  /**
   * Update face positions after transform changes
   */
  private updateFacePositions(): void {
    this.faces = this.generateFaces();
  }

  /**
   * Get default color based on node type
   */
  private getDefaultColor(): string {
    const colorMap: Record<NodeType, string> = {
      [NodeType.FUNCTION]: '#4CAF50',
      [NodeType.COMPONENT]: '#2196F3',
      [NodeType.STORE]: '#9C27B0',
      [NodeType.SERVICE]: '#FF9800',
      [NodeType.LIBRARY]: '#00BCD4',
      [NodeType.HOOK]: '#E91E63',
      [NodeType.DATAPATH]: '#FF9800',
      [NodeType.MODULE]: '#9C27B0',
      [NodeType.CLASS]: '#F44336',
      [NodeType.INTERFACE]: '#00BCD4',
      [NodeType.VARIABLE]: '#FFEB3B',
      [NodeType.CONSTANT]: '#795548',
      [NodeType.PERSON]: '#FFC107',
      [NodeType.BOUNDARY]: '#E0E0E0',
      [NodeType.JUNCTION]: '#888888',
    };

    return colorMap[this.type] || '#808080';
  }
}
