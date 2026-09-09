import { NodeType, ConnectionType } from '../types/ast';
import { GeometryType } from '../types/geometry';

/**
 * Parsed node definition from Merfolk syntax
 */
export interface ParsedNode {
  id: string;
  type: NodeType;
  name: string;
  geometry: GeometryType;
  description?: string;
  properties?: Record<string, any>;
  parentId?: string; // Explicit containment target from `in <parent>` suffix
}

/**
 * Parsed connection definition from Merfolk syntax
 */
export interface ParsedConnection {
  id: string;
  type: ConnectionType;
  source: {
    nodeId: string;
    faceId?: string;
  };
  target: {
    nodeId: string;
    faceId?: string;
  };
  label?: string;
  properties?: Record<string, any>;
  flowPaths?: string[]; // IDs of flow paths this connection belongs to
  arrowStart?: boolean; // Arrowhead at the source end
  arrowEnd?: boolean; // Arrowhead at the target end
}

/**
 * Parsed flow path definition
 */
export interface ParsedFlowPath {
  id: string;
  name: string;
  nodeSequence: string[];
  connectionIds: string[];
  metadata?: Record<string, any>;
}

/**
 * A single targeted styling directive (from a `style` or `relstyle` line).
 */
export interface StyleDirective {
  kind: 'node' | 'connection';
  targets: string[]; // Node types for `style`, connection types for `relstyle`
  properties: Record<string, any>;
}

/**
 * An `align row|column` layout directive over a set of node IDs.
 */
export interface AlignmentDirective {
  mode: 'row' | 'column';
  nodeIds: string[];
}

/**
 * Parsed graph structure
 */
export interface ParsedGraph {
  title?: string;
  description?: string;
  nodes: ParsedNode[];
  connections: ParsedConnection[];
  flowPaths: ParsedFlowPath[];
  metadata?: Record<string, any>;
  styles?: StyleDirective[];
  alignments?: AlignmentDirective[];
}

/**
 * Parser for Merfolk 3D AST syntax
 */
export class MermaidParser {
  private lines: string[] = [];
  private currentLine = 0;
  private nodes: ParsedNode[] = [];
  private connections: ParsedConnection[] = [];
  private flowPaths: ParsedFlowPath[] = [];
  private styles: StyleDirective[] = [];
  private alignments: AlignmentDirective[] = [];
  private nodeIdCounter = 0;
  private connectionIdCounter = 0;
  private flowPathIdCounter = 0;
  private seenNodeIds: Set<string> = new Set();

  /**
   * Parse Merfolk syntax into graph structure
   */
  parse(input: string): ParsedGraph {
    this.reset();
    this.lines = input
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    let title: string | undefined;
    let description: string | undefined;
    const metadata: Record<string, any> = {};

    for (
      this.currentLine = 0;
      this.currentLine < this.lines.length;
      this.currentLine++
    ) {
      const line = this.lines[this.currentLine];

      // Skip comments
      if (line.startsWith('%%') || line.startsWith('//')) {
        continue;
      }

      // Parse graph declaration
      if (line.startsWith('graph3d') || line.startsWith('ast3d')) {
        const match = line.match(/^(graph3d|ast3d)\s+(.+)/);
        if (match) {
          title = match[2].replace(/['"]/g, '');
        }
        continue;
      }

      // Parse title
      if (line.startsWith('title:')) {
        title = line.substring(6).trim().replace(/['"]/g, '');
        continue;
      }

      // Parse description
      if (line.startsWith('description:')) {
        description = line.substring(12).trim().replace(/['"]/g, '');
        continue;
      }

      // Parse flow path definitions
      if (line.startsWith('flowpath ')) {
        const flowPath = this.parseFlowPathDefinition(line);
        if (flowPath) {
          this.flowPaths.push(flowPath);
        }
        continue;
      }

      // Parse junction declarations (volume-less rendezvous points)
      if (line.startsWith('junction ')) {
        const node = this.parseJunction(line);
        if (node) {
          if (this.seenNodeIds.has(node.id)) {
            console.warn(
              `[MermaidParser] Skipping duplicate junction: ${node.id}`
            );
          } else {
            this.seenNodeIds.add(node.id);
            this.nodes.push(node);
          }
        }
        continue;
      }

      // Parse style directives
      if (line.startsWith('style ')) {
        const style = this.parseStyleDirective(line);
        if (style) this.styles.push(style);
        continue;
      }

      // Parse relation style directives
      if (line.startsWith('relstyle ')) {
        const style = this.parseStyleDirective(line, true);
        if (style) this.styles.push(style);
        continue;
      }

      // Parse alignment directives
      if (line.startsWith('align ')) {
        const alignment = this.parseAlignmentDirective(line);
        if (alignment) this.alignments.push(alignment);
        continue;
      }

      // Parse bare brace declarations, e.g. `{Boundary: PCI-DSS Zone}` or
      // `{Component: Checkout}`. These have no explicit node id — the label
      // doubles as the id so it can be referenced by `in <...>` membership.
      if (/^\{[^\s{][^}]*\}/.test(line.trim())) {
        const node = this.parseBareBraceDeclaration(line.trim());
        if (node) {
          if (this.seenNodeIds.has(node.id)) {
            console.warn(`[MermaidParser] Skipping duplicate node: ${node.id}`);
          } else {
            this.seenNodeIds.add(node.id);
            this.nodes.push(node);
          }
        }
        continue;
      }

      // Parse node definition (skip duplicates)
      if (this.isNodeDefinition(line)) {
        const node = this.parseNodeDefinition(line);
        if (node) {
          if (this.seenNodeIds.has(node.id)) {
            console.warn(`[MermaidParser] Skipping duplicate node: ${node.id}`);
          } else {
            this.seenNodeIds.add(node.id);
            this.nodes.push(node);
          }
        }
        continue;
      }

      // Parse connection
      if (this.isConnectionDefinition(line)) {
        const connection = this.parseConnectionDefinition(line);
        if (connection) {
          this.connections.push(connection);
        }
        continue;
      }

      // Parse metadata
      if (
        line.includes(':') &&
        !line.includes('-->') &&
        !line.includes('---')
      ) {
        const [key, value] = line.split(':', 2);
        metadata[key.trim()] = value.trim().replace(/['"]/g, '');
      }
    }

    return {
      title,
      description,
      nodes: this.nodes,
      connections: this.connections,
      flowPaths: this.flowPaths,
      metadata,
      styles: this.styles,
      alignments: this.alignments,
    };
  }

  /**
   * Reset parser state
   */
  private reset(): void {
    this.lines = [];
    this.currentLine = 0;
    this.nodes = [];
    this.connections = [];
    this.flowPaths = [];
    this.styles = [];
    this.alignments = [];
    this.nodeIdCounter = 0;
    this.connectionIdCounter = 0;
    this.flowPathIdCounter = 0;
    this.seenNodeIds = new Set();
  }
  /**
   * Check if line is a node definition
   */
  private isNodeDefinition(line: string): boolean {
    // Examples:
    // A[Function: processData]
    // B{Component: UserInterface}
    // C((Module: Database))
    // D<Datapath: eventStream>
    // E[[Class: UserModel]]
    // P~Person: Alice~          (tilde — person sphere)
    // Q[Service: checkouts] in <payments>   (explicit containment)
    return /^[A-Za-z0-9_/.\-]+[\[\{\(<~]/.test(line);
  }

  /**
   * Check if line is a connection definition
   */
  private isConnectionDefinition(line: string): boolean {
    return (
      line.includes('-->') ||
      line.includes('---') ||
      line.includes('-.->') ||
      line.includes('==') ||
      line.includes('*-->') ||
      line.includes('..>') ||
      line.includes('<--')
    );
  }

  /**
   * Parse node definition
   */
  private parseNodeDefinition(line: string): ParsedNode | null {
    // Match patterns like:
    // A[Function: processData]
    // B{Component: UserInterface}
    // C((Module: Database))
    // D<Datapath: eventStream>
    // E[[Class: UserModel]]

    // Double-bracket must come before single-bracket so that
    // [[Store: x]], [[Class: x]], [[Interface: x]] are parsed with their correct
    // type strings rather than the single-bracket regex capturing "[Store" as
    // the type and falling back to NodeType.COMPONENT.  The downstream hierarchy
    // methods (hierarchyMethods.js) have store→cubeChild branches to handle
    // these types correctly, and positionMethods.js section 8 positions children
    // of grouped store/service/hook containers.
    // Node ID character class allows /, ., - so package paths like
    // `firebase-admin/app`, `eslint-plugin-react`, `firebase-functions/v2/https`
    // survive as parser-readable node IDs. `@` is intentionally excluded so the
    // optional `@face` separator in connection patterns stays unambiguous; the
    // emitter (githubRepoService) replaces leading `@` with `_` for npm scopes.
    const patterns = [
      /^([A-Za-z0-9_/.\-]+)~([^:]+):\s*([^~]+)~/,              // Tilde (person sphere)
      /^([A-Za-z0-9_/.\-]+)\[\[([^:]+):\s*([^\]]+)\]\]/,  // Double square brackets (must be before single)
      /^([A-Za-z0-9_/.\-]+)\[([^:]+):\s*([^\]]+)\]/,      // Square brackets
      /^([A-Za-z0-9_/.\-]+)\{([^:]+):\s*([^\}]+)\}/,      // Curly brackets
      /^([A-Za-z0-9_/.\-]+)\(\(([^:]+):\s*([^\)]+)\)\)/,  // Double parentheses
      /^([A-Za-z0-9_/.\-]+)<([^:]+):\s*([^>]+)>/,         // Angle brackets
    ];

    for (const pattern of patterns) {
      const match = line.match(pattern);
      if (match) {
        const [, id, typeStr, name] = match;

        const type = this.parseNodeType(typeStr);
        const geometry = this.parseGeometry(line);

        // Check if there's a property block starting on this line or the next
        let properties: Record<string, any> = {};

        // Check if current line has inline properties
        const inlinePropsMatch = line.match(/\s*\{(.+)\}\s*$/);
        if (inlinePropsMatch) {
          properties = this.parseProperties(inlinePropsMatch[1]);
        } else {
          // Check if next line starts a property block
          properties = this.parseMultiLineProperties();
        }

        // Explicit containment: `Node[...] in <parentId>` (or ` in parentId`).
        // Consumed only AFTER the matched node token so label text containing
        // " in " is never misinterpreted.
        let parentId: string | undefined;
        const remainder = line.substring(match[0].length).trim();
        const parentMatch = remainder.match(
          /^in\s+(?:<([A-Za-z0-9_/.\- ]+)>|([A-Za-z0-9_/.\-]+))/
        );
        if (parentMatch) {
          parentId = parentMatch[1] || parentMatch[2];
        }

        return {
          id: id || `node_${this.nodeIdCounter++}`,
          type,
          name: name.trim(),
          geometry,
          description: properties.description,
          properties,
          parentId,
        };
      }
    }

    return null;
  }

  /**
   * Parse connection definition
   */
  private parseConnectionDefinition(line: string): ParsedConnection | null {
    // Match patterns like:
    // A --> B
    // A -.-> B : "data flow"
    // A --- B
    // A --> B@front
    // A@back --> B@top
    // A -->|"label"| B (Mermaid-style labeled connections)
    // A --> B : "data flow" #myFlowPath (tagged with flow path)
    // A --> B #flow1 #flow2 (multiple flow path tags)

    // Extract flow path tags (e.g. #myFlow #anotherFlow) from end of line
    const flowPathTags: string[] = [];
    let cleanLine = line;
    const tagMatches = line.match(/#([A-Za-z0-9_-]+)/g);
    if (tagMatches) {
      for (const tag of tagMatches) {
        flowPathTags.push(tag.substring(1)); // Remove the # prefix
      }
      // Remove flow path tags from the line for normal parsing
      cleanLine = line.replace(/\s*#[A-Za-z0-9_-]+/g, '').trim();
    }

    const patterns = [
      // Pattern for -->|"label"| syntax (Mermaid-style)
      /^([A-Za-z0-9_/.\-]+)(?:@([A-Za-z0-9_]+))?\s*(<)?(-->|---|-.->|==|\*-->|\.\.>|--)(>)?\s*\|\s*['""]([^'"]+)['"]\s*\|\s*([A-Za-z0-9_/.\-]+)(?:@([A-Za-z0-9_]+))?/,
      // Pattern for : "label" syntax (original)
      /^([A-Za-z0-9_/.\-]+)(?:@([A-Za-z0-9_]+))?\s*(<)?(-->|---|-.->|==|\*-->|\.\.>|--)(>)?\s*([A-Za-z0-9_/.\-]+)(?:@([A-Za-z0-9_]+))?\s*(?::\s*['""]([^'"]+)['""])?/,
    ];

    // Per-end arrowheads. A leading ` < ` decorator shows an arrowhead at the
    // SOURCE, a trailing ` > ` shows one at the TARGET; bare `-->`-family tokens
    // that already end in `>` default to arrowEnd (headless `---`/`==`/`--`
    // stay headless unless decorated).
    for (const pattern of patterns) {
      const match = cleanLine.match(pattern);
      if (match) {
        let sourceId, sourceFace, arrow, targetId, targetFace, label;
        let startDecorator, endDecorator;

        if (pattern === patterns[0]) {
          // -->|"label"| syntax
          [, sourceId, sourceFace, startDecorator, arrow, endDecorator, label, targetId, targetFace] = match;
        } else {
          // : "label" syntax
          [, sourceId, sourceFace, startDecorator, arrow, endDecorator, targetId, targetFace, label] = match;
        }

        const type = this.parseConnectionType(arrow);
        const arrowStart = startDecorator === '<';
        const arrowEnd = endDecorator === '>' || (arrow ? arrow.endsWith('>') : false);

        return {
          id: `conn_${this.connectionIdCounter++}`,
          type,
          source: {
            nodeId: sourceId,
            faceId: sourceFace,
          },
          target: {
            nodeId: targetId,
            faceId: targetFace,
          },
          label,
          properties: {},
          flowPaths: flowPathTags.length > 0 ? flowPathTags : undefined,
          arrowStart,
          arrowEnd,
        };
      }
    }

    return null;
  }

  /**
   * Parse node type from string
   */
  private parseNodeType(typeStr: string): NodeType {
    const type = typeStr.toLowerCase().trim();

    switch (type) {
      case 'function':
      case 'func':
        return NodeType.FUNCTION;
      case 'component':
      case 'comp':
        return NodeType.COMPONENT;
      case 'store':
        return NodeType.STORE;
      case 'service':
      case 'svc':
        return NodeType.SERVICE;
      case 'library':
      case 'lib':
        return NodeType.LIBRARY;
      case 'hook':
        return NodeType.HOOK;
      case 'datapath':
      case 'data':
        return NodeType.DATAPATH;
      case 'module':
      case 'mod':
        return NodeType.MODULE;
      case 'class':
        return NodeType.CLASS;
      case 'interface':
      case 'iface':
        return NodeType.INTERFACE;
      case 'variable':
      case 'var':
        return NodeType.VARIABLE;
      case 'constant':
      case 'const':
        return NodeType.CONSTANT;
      // Extended types emitted by the repo scanner for backend/infra nodes —
      // map to the closest semantic equivalent so they get proper icons and
      // are grouped rather than falling back to component (dodecahedron).
      case 'endpoint':
      case 'route':
        return NodeType.FUNCTION;   // cube, grouped with functions
      case 'guard':
      case 'middleware':
        return NodeType.FUNCTION;   // cube, grouped with functions
      case 'boundary':
        return NodeType.BOUNDARY;   // implicit backdrop/container, not grouped
      case 'model':
        return NodeType.STORE;      // cube, grouped with stores
      case 'person':
      case 'actor':
        return NodeType.PERSON;     // sphere, root-positioned
      case 'junction':
        return NodeType.JUNCTION;   // tiny cube marker, never grouped
      default:
        return NodeType.COMPONENT; // Default fallback
    }
  }
  /**
   * Parse geometry from line (based on bracket type)
   */
  private parseGeometry(line: string): GeometryType {
    // Tilde pattern `ID~Person: Name~` -> SPHERE
    if (line.includes('~')) {
      return GeometryType.SPHERE;
    }
    // Double-bracket must come before single-bracket — [[Store: x]] contains
    // both '[' and ']' characters, so single-bracket would match first otherwise.
    // [[Store: name]] -> CUBE
    if (line.includes('[[') && line.includes(']]')) {
      return GeometryType.CUBE;
    }
    // [Function: name] -> CUBE
    else if (line.includes('[') && line.includes(']')) {
      return GeometryType.CUBE;
    }
    // {Component: name} -> DODECAHEDRON
    else if (line.includes('{') && line.includes('}')) {
      return GeometryType.DODECAHEDRON;
    }
    // ((Service: name)) -> TETRAHEDRON
    else if (line.includes('((') && line.includes('))')) {
      return GeometryType.TETRAHEDRON;
    }
    // <Library: name> -> CUBE
    else if (line.includes('<') && line.includes('>')) {
      return GeometryType.CUBE;
    }

    return GeometryType.CUBE; // Default
  }

  /**
   * Parse connection type from arrow
   */
  private parseConnectionType(arrow: string): ConnectionType {
    switch (arrow) {
      case '-->':
        return ConnectionType.DATA_FLOW;
      case '-.->':
        return ConnectionType.CONTROL_FLOW;
      case '---':
        return ConnectionType.ASSOCIATION;
      case '==':
        return ConnectionType.INHERITANCE;
      case '*-->':
        return ConnectionType.COMPOSITION;
      case '..>':
        return ConnectionType.DEPENDENCY;
      case '--':
        return ConnectionType.ASSOCIATION;
      default:
        return ConnectionType.ASSOCIATION;
    }
  }

  /**
   * Parse properties from string
   */
  private parseProperties(propertiesStr: string): Record<string, any> {
    const properties: Record<string, any> = {};

    // Simple key:value parsing
    const pairs = propertiesStr.split(',').map((pair) => pair.trim());

    for (const pair of pairs) {
      const [key, value] = pair.split(':').map((s) => s.trim());
      if (key && value) {
        properties[key] = value.replace(/['"]/g, '');
      }
    }

    return properties;
  }

  /**
   * Parse a `junction J1` declaration into a volume-less rendezvous marker.
   */
  private parseJunction(line: string): ParsedNode | null {
    const match = line.match(/^junction\s+([A-Za-z0-9_/.\-]+)/);
    if (!match) return null;
    const id = match[1];
    return {
      id,
      type: NodeType.JUNCTION,
      name: id,
      geometry: GeometryType.CUBE,
      properties: {},
    };
  }

  /**
   * Parse a bare brace declaration: `{Boundary: PCI-DSS Zone}` or
   * `{Component: Checkout}`. No explicit id prefix — the label doubles as the
   * node id (so it can be referenced by `in <...>` membership and connections)
   * and as the display name. Unrecognized keywords default to Component.
   */
  private parseBareBraceDeclaration(line: string): ParsedNode | null {
    const match = line.match(/^\{\s*([^:]+):\s*([^}]+)\}$/);
    if (!match) return null;
    const type = this.parseNodeType(match[1].trim());
    const label = match[2].trim();
    return {
      id: label,
      type,
      name: label,
      geometry: GeometryType.DODECAHEDRON,
      properties: {},
    };
  }

  /**
   * Parse a single-line `key: value` property block. Values may be quoted
   * strings, numbers, booleans, arrays, or nested brace objects.
   */
  private parseInlineBlockProps(block: string): Record<string, any> {
    const properties: Record<string, any> = {};
    const re = /([A-Za-z_][A-Za-z0-9_]*)\s*:\s*((?:"[^"]*"|'[^']*'|\[[^\]]*\]|\{[^{}]*\}|[^,\s{}]+))/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(block)) !== null) {
      let value: any = m[2].trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      } else if (
        (value.startsWith('[') && value.endsWith(']')) ||
        (value.startsWith('{') && value.endsWith('}'))
      ) {
        try {
          value = JSON.parse(value);
        } catch {
          // Keep as string if JSON parsing fails
        }
      } else if (!isNaN(Number(value))) {
        value = Number(value);
      } else if (value === 'true') {
        value = true;
      } else if (value === 'false') {
        value = false;
      }
      properties[m[1]] = value;
    }
    return properties;
  }

  /**
   * Parse a `style`/`relstyle` directive.
   *   style  Component, Service { color: "#f00", opacity: 0.9 }   // by node type
   *   relstyle dataflow          { color: "#0ff", lineStyle: "dashed" } // by connection type
   */
  private parseStyleDirective(line: string, isRel = false): StyleDirective | null {
    const match = line.match(/^(?:style|relstyle)\s+(.+?)\s*\{\s*(.*?)\s*\}$/);
    if (!match) return null;
    const targets = match[1]
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (targets.length === 0) return null;
    const properties = this.parseInlineBlockProps(match[2]);
    return {
      kind: isRel ? 'connection' : 'node',
      targets,
      properties,
    };
  }

  /**
   * Parse an `align row|column` directive.
   *   align row A B C
   *   align column D E F
   */
  private parseAlignmentDirective(line: string): AlignmentDirective | null {
    const match = line.match(/^align\s+(row|column)\s+(.+)$/);
    if (!match) return null;
    const mode = match[1] as AlignmentDirective['mode'];
    const nodeIds = match[2]
      .trim()
      .split(/\s+/)
      .filter((s) => s.length > 0);
    if (nodeIds.length < 2) return null;
    return { mode, nodeIds };
  }

  /**
   * Parse multi-line property block
   */
  private parseMultiLineProperties(): Record<string, any> {
    const properties: Record<string, any> = {};

    // Check if the next line starts with '{'
    if (
      this.currentLine + 1 < this.lines.length &&
      this.lines[this.currentLine + 1].trim() === '{'
    ) {
      this.currentLine++; // Skip the opening '{'
      this.currentLine++; // Move to first property line

      // Parse properties until we hit the closing '}'
      while (this.currentLine < this.lines.length) {
        const line = this.lines[this.currentLine].trim();

        // End of property block
        if (line === '}') {
          break;
        }

        // Parse property line
        if (line.includes(':')) {
          const [key, ...valueParts] = line.split(':');
          const value = valueParts.join(':').trim();

          if (key && value) {
            // Handle different value types
            let parsedValue: any = value.replace(/['"]/g, '');

            // Try to parse as number
            if (!isNaN(Number(parsedValue))) {
              parsedValue = Number(parsedValue);
            }

            // Try to parse as array (simple format like [0, 0, 0])
            if (typeof parsedValue === 'string' && parsedValue.startsWith('[') && parsedValue.endsWith(']')) {
              try {
                parsedValue = JSON.parse(parsedValue);
              } catch (e) {
                // Keep as string if JSON parsing fails
              }
            }

            properties[key.trim()] = parsedValue;
          }
        }

        this.currentLine++;
      }
    }

    return properties;
  }

  /**
   * Parse a flow path definition line.
   *
   * Syntax:
   *   flowpath "name" : A --> B --> C --> D
   *   flowpath "name" : A --> B --> C --> D : "description"
   *   flowpath "name" (-->|-.->|---|==) : A --> B --> C
   *
   * This creates individual connections between each adjacent pair of nodes,
   * all tagged with the same flow path ID, enabling full data-path tracing.
   */
  private parseFlowPathDefinition(line: string): ParsedFlowPath | null {
    // Match: flowpath "name" : A --> B --> C --> D
    // Optional arrow type override: flowpath "name" (-->) : A --> B --> C
    // Optional trailing description: ... : "description"
    const flowPathMatch = line.match(
      /^flowpath\s+['""]([^'"]+)['""](?:\s*\(([^)]+)\))?\s*:\s*(.+?)(?:\s*:\s*['""]([^'"]+)['""])?$/
    );
    if (!flowPathMatch) return null;

    const [, name, arrowOverride, pathPart, description] = flowPathMatch;

    // Parse the node chain: A --> B --> C --> D
    // We split on arrow patterns (including `<--`/`<-->` decorated forms)
    // to extract the node IDs.
    const nodeIds = pathPart
      .split(/\s*(?:<-->|<--|-->|-.->|---|==|\*-->|\.\.>|--)\s*/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    if (nodeIds.length < 2) return null;

    const flowPathId = `flowpath_${this.flowPathIdCounter++}`;
    const connectionType = arrowOverride
      ? this.parseConnectionType(arrowOverride.trim())
      : ConnectionType.DATA_FLOW;

    // Flow paths are directional by default (data travels `-->`); an explicit
    // arrow-type override keeps its own decorations.
    const arrowStart = arrowOverride ? /^</.test(arrowOverride.trim()) : false;
    const arrowEnd = arrowOverride ? />$/.test(arrowOverride.trim()) : true;

    // Create connections for each adjacent pair, all tagged with this flow path
    const connectionIds: string[] = [];
    for (let i = 0; i < nodeIds.length - 1; i++) {
      const connId = `conn_${this.connectionIdCounter++}`;
      connectionIds.push(connId);

      // Check if there's already a connection between these two nodes
      const existingConn = this.connections.find(
        (c) =>
          c.source.nodeId === nodeIds[i] && c.target.nodeId === nodeIds[i + 1]
      );

      if (existingConn) {
        // Tag the existing connection with this flow path
        if (!existingConn.flowPaths) {
          existingConn.flowPaths = [];
        }
        existingConn.flowPaths.push(name);
        connectionIds[connectionIds.length - 1] = existingConn.id;
      } else {
        // Create a new connection
        this.connections.push({
          id: connId,
          type: connectionType,
          source: { nodeId: nodeIds[i] },
          target: { nodeId: nodeIds[i + 1] },
          label: undefined,
          properties: {},
          flowPaths: [name],
          arrowStart,
          arrowEnd,
        });
      }
    }

    return {
      id: flowPathId,
      name,
      nodeSequence: nodeIds,
      connectionIds,
      metadata: description ? { description } : undefined,
    };
  }
}
