import { Position3D } from '../types/geometry';
import { ConnectionType, VisualProperties } from '../types/ast';

/**
 * Connection point on a node
 */
export interface ConnectionPoint {
  nodeId: string;
  faceId?: string;
  anchor?: Position3D;
}

/**
 * 3D Connection between nodes
 */
export class Connection {
  public id: string;
  public type: ConnectionType;
  public source: ConnectionPoint;
  public target: ConnectionPoint;
  public label?: string;
  public visual: VisualProperties;
  public metadata: Record<string, any>;
  public waypoints: Position3D[];
  public flowPaths: string[]; // Flow path IDs this connection belongs to
  public arrowStart: boolean = false; // Render an arrowhead at the source end
  public arrowEnd: boolean = false; // Render an arrowhead at the target end

  constructor(
    id: string,
    type: ConnectionType,
    source: ConnectionPoint,
    target: ConnectionPoint,
    label?: string
  ) {
    this.id = id;
    this.type = type;
    this.source = source;
    this.target = target;
    this.label = label;
    this.visual = {
      color: this.getDefaultColor(),
      opacity: 0.8,
    };
    this.metadata = {};
    this.waypoints = [];
    this.flowPaths = [];
  }

  /**
   * Add this connection to a flow path
   */
  addFlowPath(flowPathId: string): void {
    if (!this.flowPaths.includes(flowPathId)) {
      this.flowPaths.push(flowPathId);
    }
  }

  /**
   * Remove this connection from a flow path
   */
  removeFlowPath(flowPathId: string): void {
    this.flowPaths = this.flowPaths.filter((id) => id !== flowPathId);
  }

  /**
   * Check if this connection belongs to a specific flow path
   */
  belongsToFlowPath(flowPathId: string): boolean {
    return this.flowPaths.includes(flowPathId);
  }

  /**
   * Add a waypoint to the connection path
   */
  addWaypoint(position: Position3D): void {
    this.waypoints.push({ ...position });
  }

  /**
   * Remove all waypoints
   */
  clearWaypoints(): void {
    this.waypoints = [];
  }

  /**
   * Set custom waypoints
   */
  setWaypoints(waypoints: Position3D[]): void {
    this.waypoints = waypoints.map((wp) => ({ ...wp }));
  }

  /**
   * Calculate the path length of the connection
   */
  getPathLength(): number {
    if (this.waypoints.length === 0) {
      // Direct connection
      if (this.source.anchor && this.target.anchor) {
        return this.calculateDistance(this.source.anchor, this.target.anchor);
      }
      return 0;
    }

    let totalLength = 0;
    let previousPoint = this.source.anchor;

    if (!previousPoint) return 0;

    for (const waypoint of this.waypoints) {
      totalLength += this.calculateDistance(previousPoint, waypoint);
      previousPoint = waypoint;
    }

    if (this.target.anchor) {
      totalLength += this.calculateDistance(previousPoint, this.target.anchor);
    }

    return totalLength;
  }

  /**
   * Get all points in the connection path
   */
  getPathPoints(): Position3D[] {
    const points: Position3D[] = [];

    if (this.source.anchor) {
      points.push(this.source.anchor);
    }

    points.push(...this.waypoints);

    if (this.target.anchor) {
      points.push(this.target.anchor);
    }

    return points;
  }

  /**
   * Check if this connection intersects with another connection
   */
  intersectsWith(other: Connection): boolean {
    // Simplified intersection check
    // In a real implementation, you'd do proper 3D line intersection
    const thisPoints = this.getPathPoints();
    const otherPoints = other.getPathPoints();

    if (thisPoints.length < 2 || otherPoints.length < 2) {
      return false;
    }

    // Check bounding box intersection as a quick test
    const thisBounds = this.getBoundingBox();
    const otherBounds = other.getBoundingBox();

    return this.boundingBoxesIntersect(thisBounds, otherBounds);
  }

  /**
   * Get the bounding box of the connection
   */
  getBoundingBox(): { min: Position3D; max: Position3D } {
    const points = this.getPathPoints();

    if (points.length === 0) {
      return {
        min: { x: 0, y: 0, z: 0 },
        max: { x: 0, y: 0, z: 0 },
      };
    }

    const min = { ...points[0] };
    const max = { ...points[0] };

    for (const point of points) {
      min.x = Math.min(min.x, point.x);
      min.y = Math.min(min.y, point.y);
      min.z = Math.min(min.z, point.z);

      max.x = Math.max(max.x, point.x);
      max.y = Math.max(max.y, point.y);
      max.z = Math.max(max.z, point.z);
    }

    return { min, max };
  }

  /**
   * Update connection anchors based on node positions
   */
  updateAnchors(sourceAnchor: Position3D, targetAnchor: Position3D): void {
    this.source.anchor = { ...sourceAnchor };
    this.target.anchor = { ...targetAnchor };
  }

  /**
   * Calculate distance between two points
   */
  private calculateDistance(p1: Position3D, p2: Position3D): number {
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const dz = p2.z - p1.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  /**
   * Check if two bounding boxes intersect
   */
  private boundingBoxesIntersect(
    box1: { min: Position3D; max: Position3D },
    box2: { min: Position3D; max: Position3D }
  ): boolean {
    return (
      box1.min.x <= box2.max.x &&
      box1.max.x >= box2.min.x &&
      box1.min.y <= box2.max.y &&
      box1.max.y >= box2.min.y &&
      box1.min.z <= box2.max.z &&
      box1.max.z >= box2.min.z
    );
  }

  /**
   * Get default color based on connection type
   */
  private getDefaultColor(): string {
    const colorMap: Record<ConnectionType, string> = {
      [ConnectionType.DATA_FLOW]: '#4CAF50',
      [ConnectionType.CONTROL_FLOW]: '#F44336',
      [ConnectionType.INHERITANCE]: '#2196F3',
      [ConnectionType.COMPOSITION]: '#FF9800',
      [ConnectionType.DEPENDENCY]: '#9C27B0',
      [ConnectionType.ASSOCIATION]: '#607D8B',
    };

    return colorMap[this.type] || '#808080';
  }
}
