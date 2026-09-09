/**
 * 3D Position in space
 */
export interface Position3D {
  x: number;
  y: number;
  z: number;
}

/**
 * 3D Rotation in euler angles
 */
export interface Rotation3D {
  x: number;
  y: number;
  z: number;
}

/**
 * 3D Scale factors
 */
export interface Scale3D {
  x: number;
  y: number;
  z: number;
}

/**
 * 3D Transform combining position, rotation, and scale
 */
export interface Transform3D {
  position: Position3D;
  rotation: Rotation3D;
  scale: Scale3D;
}

/**
 * Supported 3D geometry types
 */
export enum GeometryType {
  CUBE = 'cube',
  TETRAHEDRON = 'tetrahedron',
  DODECAHEDRON = 'dodecahedron',
  SPHERE = 'sphere',
}

/**
 * Face of a 3D object that can be connected to
 */
export interface Face {
  id: string;
  normal: Position3D;
  center: Position3D;
  vertices: Position3D[];
}

/**
 * Bounding box for collision detection and positioning
 */
export interface BoundingBox {
  min: Position3D;
  max: Position3D;
  center: Position3D;
  size: Position3D;
}
