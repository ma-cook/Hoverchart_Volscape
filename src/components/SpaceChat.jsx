import { useEffect, useRef, useState, useCallback } from 'react';
import { onSocket, emitSocket } from '../api-client';
import { buildZenMessages, buildCodeGenMessages, fetchRepoContext, populateContentStoreWorker } from '../services/zenService';
import { sendWithRetrieval, getContentStore, waitForContentStoreHydration } from '../services/context';
import { extractMerfolkBlocks } from '../services/merfolkExtractor';
import { enrichPlanMerfolk } from '../services/planMerfolkEnricher';
import { extractCodeBlocks } from '../services/codeExtractor';
import useObjectsStore from '../stores/objectsStore';
import useCodeStore from '../stores/codeStore';
import useLlmStore from '../stores/llmStore';
import useDiagramStore from '../stores/diagramStore';
import { PROVIDERS, fetchModels, isFreeUsageLimit } from '../services/llmProviders';
import { getMarkdownLayoutWorker } from '../workers/markdownLayoutWorkerClient';
import { markdownDiagramService } from '../services/markdownDiagramService';
import {
  getGithubToken,
  isGithubAuthenticated,
  getGithubOAuthUrl,
  fetchRepositories,
  fetchFileContent,
} from '../services/githubRepoService';
import {
  getBranchRef,
  createBranchRef,
} from '../services/githubIssuesService';
import { listBranches, applySearchReplace, hasSearchReplaceMarkers, parseSearchReplaceBlocks } from '../services/githubPushService';
import { diffToHunks, buildSearchReplaceBlock } from '../services/context/diffUtils';
import { scanRepositoryAndGenerateDiagram } from '../services/githubRepoService';
import { uploadMarkdownToStorage } from '../services/storageService';
import { saveDiagramDigest } from '../services/graphPersistence';
import { createTicket, updateTicket, emitTicketCreated, emitTicketUpdated } from '../services/workflowService';
import { buildWorkflowContext } from '../services/workflowCoordination';
import usePlanStore from '../stores/planStore';

const getGuestId = () => {
  let guestId = sessionStorage.getItem('guestPresenceId');
  if (!guestId) {
    guestId = `guest_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    sessionStorage.setItem('guestPresenceId', guestId);
  }
  return guestId;
};

// The commit SHA the current space's diagram was scanned/rescanned at (persisted
// by UIOverlay). Threaded into githubContext so every GitHub fetch in the tool
// loop pins to that commit instead of falling back to the module-global
// repoRefSha — which can point at a different space's scan and makes search line
// numbers disagree with reads.
const getSpaceCommitSha = (spaceId) => {
  if (!spaceId) return undefined;
  try {
    return localStorage.getItem(`diagramCommitSha_${spaceId}`) || undefined;
  } catch {
    return undefined;
  }
};

const senderInitials = (name) => {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  return parts.length === 1
    ? parts[0][0].toUpperCase()
    : (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
};

async function renderMerfolkToScene(merfolkBlocks, spaceId, user) {
  if (!merfolkBlocks || merfolkBlocks.length === 0) return false;

  const markdown = merfolkBlocks
    .map(block => '```merfolk\n' + block + '\n```')
    .join('\n\n');

  const basePosition = markdownDiagramService.getCameraBasedPosition();

  let workerResult = null;
  try {
    const layoutWorker = getMarkdownLayoutWorker();
    workerResult = await layoutWorker.computeLayout(markdown, basePosition);
  } catch (err) {
    console.warn('[SpaceChat] Layout worker failed:', err.message);
    return false;
  }

  if (!workerResult || !workerResult.diagramLayouts || workerResult.diagramLayouts.length === 0) {
    return false;
  }

  const diagrams = workerResult.diagramLayouts.map((layout) => ({
    graph: {
      nodes: new Map(layout.graphNodes),
      connections: new Map(
        layout.rawConnections.map((c, i) => [
          `hc-${i}`,
          { source: c.source, target: c.target, label: c.label, type: c.connectionType, visual: c.visual || null },
        ])
      ),
    },
    errors: layout.errors || [],
  }));

  const connectionTags = new Map(
    workerResult.connectionTags.map(([key, tags]) => [key, new Set(tags)])
  );

  const nodeToObjectIdMap = new Map();
  const allConnectionsToSave = [];
  const allObjectsToSave = [];
  const currentSpaceId = spaceId;

  window._faceDistributionCounters = window._faceDistributionCounters || new Map();

  for (const diagram of diagrams) {
    if (diagram.errors && diagram.errors.length > 0) continue;

    await markdownDiagramService.createObjectsFromDiagram(
      diagram,
      () => {},
      nodeToObjectIdMap,
      basePosition,
      user,
      currentSpaceId,
      allObjectsToSave,
      null
    );

    markdownDiagramService.createConnectionsFromDiagram(
      diagram,
      nodeToObjectIdMap,
      allConnectionsToSave,
      connectionTags
    );
  }

  if (allConnectionsToSave.length > 0) {
    await markdownDiagramService.saveConnections(
      allConnectionsToSave,
      currentSpaceId,
      user,
      allObjectsToSave
    );
  }

  return allConnectionsToSave.length > 0 || allObjectsToSave.length > 0;
}

async function associateCodeWithScene(codeBlocks, spaceId, user) {
  if (!codeBlocks || codeBlocks.length === 0) return 0;

  const spatialPartitioning = await import('../services/spatialPartitioning');
  const getCellCoordinates = spatialPartitioning.getCellCoordinates;
  const getCellId = spatialPartitioning.getCellId;
  const { saveObjectToCell } = await import('../services/spatialObjectsService');

  const objectsStore = useObjectsStore.getState();
  const objects = objectsStore.objects;
  let associatedCount = 0;
  const newTextObjects = [];

  for (const block of codeBlocks) {
    if (block.nodeId) {
      const target = objects.find(o =>
        o.merfolkData?.nodeId === block.nodeId
      );
      if (target) {
        objectsStore.associateCodeWithObject(target.id, {
          code: block.code,
          language: block.language,
          filePath: block.filePath,
        });
        associatedCount++;

        const textId = `code-text-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        const belowPosition = [
          (target.position?.[0] || 0),
          (target.position?.[1] || 0) - 15,
          (target.position?.[2] || 0),
        ];
        const cellCoords = getCellCoordinates(belowPosition);
        const cellId = getCellId(cellCoords.x, cellCoords.y, cellCoords.z);

        const textObject = {
          id: textId,
          type: 'text',
          position: belowPosition,
          scale: [30, 20, 1],
          cellId,
          createdAt: Date.now(),
          text: block.code,
          textStyle: {
            fontSize: 16,
            color: '#d4d4d4',
            fontWeight: 'normal',
            fontFamily: 'Consolas, "Courier New", monospace',
          },
          metadata: {
            code: block.code,
            codeLanguage: block.language,
            codeFilePath: block.filePath,
          },
          merfolkData: {
            parentObjectId: target.id,
          },
        };

        newTextObjects.push(textObject);
      }
    }
  }

  if (newTextObjects.length > 0) {
    objectsStore.setObjects(current => [...current, ...newTextObjects]);
    await Promise.all(newTextObjects.map(obj =>
      saveObjectToCell(user?.uid || user, spaceId, obj).catch(() => {})
    ));
  }

  return { count: associatedCount, newTextObjects };
}


export const SPACE_CHAT_MIN_WIDTH = 240;
export const SPACE_CHAT_MIN_HEIGHT = 200;
export const SPACE_CHAT_DEFAULT_WIDTH = 300;
export const SPACE_CHAT_DEFAULT_HEIGHT = 360;
export const SPACE_CHAT_GAP = 16;

// Movable area for chat windows: clear of the top-left menu bar and the
// left-side tools column, with a small inset from the right/bottom edges.
export const CHAT_BOUNDS_LEFT = 88;
export const CHAT_BOUNDS_TOP = 72;
export const CHAT_BOUNDS_MARGIN = 16;

const MAX_PERSISTED_MESSAGES = 50;

const chatStorageKey = (spaceId, suffix, windowId) =>
  windowId > 0 ? `chat:${spaceId}:${suffix}:w${windowId}` : `chat:${spaceId}:${suffix}`;

function loadPersistedMessages(spaceId, mode, windowId) {
  try {
    const raw = localStorage.getItem(chatStorageKey(spaceId, mode, windowId));
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function persistMessages(spaceId, mode, messages, windowId) {
  try {
    const toSave = messages.slice(-MAX_PERSISTED_MESSAGES);
    localStorage.setItem(chatStorageKey(spaceId, mode, windowId), JSON.stringify(toSave));
  } catch { /* ignore */ }
}

function loadPersistedMode(spaceId, windowId) {
  try {
    return localStorage.getItem(chatStorageKey(spaceId, 'mode', windowId)) || 'group';
  } catch { return 'group'; }
}

function persistMode(spaceId, mode, windowId) {
  try {
    localStorage.setItem(chatStorageKey(spaceId, 'mode', windowId), mode);
  } catch { /* ignore */ }
}

function loadWindowLlm(windowId) {
  const s = useLlmStore.getState();
  if (windowId === 0) {
    return { providerId: s.providerId, apiKey: s.apiKey, selectedModel: s.selectedModel };
  }
  let persisted = { providerId: null, apiKey: null, selectedModel: null };
  try {
    persisted = {
      providerId: JSON.parse(localStorage.getItem(`llm:window:${windowId}:providerId`) || 'null'),
      apiKey: JSON.parse(localStorage.getItem(`llm:window:${windowId}:apiKey`) || 'null'),
      selectedModel: JSON.parse(localStorage.getItem(`llm:window:${windowId}:selectedModel`) || 'null'),
    };
  } catch { /* ignore */ }
  return {
    providerId: persisted.providerId || s.providerId || null,
    apiKey: persisted.apiKey || s.apiKey || null,
    selectedModel: persisted.selectedModel || s.selectedModel || null,
  };
}

function persistWindowLlm(windowId, key, value) {
  if (windowId === 0) return;
  try {
    localStorage.setItem(`llm:window:${windowId}:${key}`, JSON.stringify(value));
  } catch { /* ignore */ }
}

const SpaceChat = ({ spaceId, user, isOpen, onClose, onCreateObject, onDiagramGenerated, onAddChat, windowId = 0, layout, onLayoutChange }) => {
  const isPrimary = windowId === 0;

  const [isExpanded, setIsExpanded] = useState(false);
  const [dragging, setDragging] = useState(null);
  const [resizing, setResizing] = useState(null);

  const currentLayout =
    layout && layout.x != null && layout.y != null
      ? layout
      : { x: CHAT_BOUNDS_LEFT, y: CHAT_BOUNDS_TOP, width: SPACE_CHAT_DEFAULT_WIDTH, height: SPACE_CHAT_DEFAULT_HEIGHT };
  const currentLayoutRef = useRef(currentLayout);
  currentLayoutRef.current = currentLayout;

  useEffect(() => {
    if (!dragging) return;
    const handleMove = (e) => {
      const cl = currentLayoutRef.current;
      const dx = e.clientX - dragging.startX;
      const dy = e.clientY - dragging.startY;
      const minX = CHAT_BOUNDS_LEFT;
      const minY = CHAT_BOUNDS_TOP;
      const maxX = Math.max(minX, window.innerWidth - CHAT_BOUNDS_MARGIN - cl.width);
      const maxY = Math.max(minY, window.innerHeight - CHAT_BOUNDS_MARGIN - cl.height);
      if (onLayoutChange) {
        onLayoutChange({
          ...cl,
          x: Math.min(maxX, Math.max(minX, dragging.startLeft + dx)),
          y: Math.min(maxY, Math.max(minY, dragging.startTop + dy)),
        });
      }
    };
    const handleUp = () => setDragging(null);
    document.addEventListener('mousemove', handleMove);
    document.addEventListener('mouseup', handleUp);
    return () => {
      document.removeEventListener('mousemove', handleMove);
      document.removeEventListener('mouseup', handleUp);
    };
  }, [dragging, onLayoutChange]);

  useEffect(() => {
    if (!resizing) return;
    const handleMove = (e) => {
      const cl = currentLayoutRef.current;
      const dx = e.clientX - resizing.startX;
      const dy = e.clientY - resizing.startY;
      const next = { ...cl };
      const maxW = Math.max(SPACE_CHAT_MIN_WIDTH, window.innerWidth - CHAT_BOUNDS_MARGIN - cl.x);
      const maxH = Math.max(SPACE_CHAT_MIN_HEIGHT, window.innerHeight - CHAT_BOUNDS_MARGIN - cl.y);
      if (resizing.edge === 'right' || resizing.edge === 'corner') {
        next.width = Math.min(maxW, Math.max(SPACE_CHAT_MIN_WIDTH, resizing.startWidth + dx));
      }
      if (resizing.edge === 'left') {
        const maxNewX = resizing.startLeft + resizing.startWidth - SPACE_CHAT_MIN_WIDTH;
        const newX = Math.min(maxNewX, Math.max(CHAT_BOUNDS_LEFT, resizing.startLeft + dx));
        next.x = newX;
        next.width = resizing.startLeft + resizing.startWidth - newX;
      }
      if (resizing.edge === 'bottom' || resizing.edge === 'corner') {
        next.height = Math.min(maxH, Math.max(SPACE_CHAT_MIN_HEIGHT, resizing.startHeight + dy));
      }
      if (onLayoutChange) onLayoutChange(next);
    };
    const handleUp = () => setResizing(null);
    document.addEventListener('mousemove', handleMove);
    document.addEventListener('mouseup', handleUp);
    return () => {
      document.removeEventListener('mousemove', handleMove);
      document.removeEventListener('mouseup', handleUp);
    };
  }, [resizing, onLayoutChange]);

  const handleResizeStart = (edge, e) => {
    e.preventDefault();
    e.stopPropagation();
    setResizing({
      edge,
      startX: e.clientX,
      startY: e.clientY,
      startWidth: currentLayout.width,
      startHeight: currentLayout.height,
      startLeft: currentLayout.x,
    });
  };

  const handleDragStart = (e) => {
    if (e.target.closest('button')) return;
    e.preventDefault();
    setDragging({
      startX: e.clientX,
      startY: e.clientY,
      startLeft: currentLayout.x,
      startTop: currentLayout.y,
    });
  };

  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [loadingMore] = useState(false);

  const textareaRef = useRef(null);
  const bottomRef = useRef(null);
  const scrollContainerRef = useRef(null);
  const oldestTimestampRef = useRef(null);
  const isNearBottomRef = useRef(true);
  const liveKeysRef = useRef(new Set());

  useEffect(() => {
    const el = textareaRef.current;
    if (!el || isExpanded) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 200) + 'px';
  }, [input, isExpanded]);

  const [chatMode, setChatMode] = useState(() => loadPersistedMode(spaceId, windowId));
  const [planMessages, setPlanMessages] = useState(() => loadPersistedMessages(spaceId, 'plan', windowId));
  const [codeMessages, setCodeMessages] = useState(() => loadPersistedMessages(spaceId, 'code', windowId));
  const [streaming, setStreaming] = useState(false);
  const [llmError, setLlmError] = useState(null);
  const streamingRef = useRef('');
  const streamingMsgKeyRef = useRef(0);
  const abortControllerRef = useRef(null);
  const rafPendingRef = useRef(false);
  const correctionsRef = useRef([]);

  const githubConnected = useCodeStore(s => s.githubConnected);
  const selectedRepo = useCodeStore(s => s.selectedRepo);
  const selectedBranch = useCodeStore(s => s.selectedBranch);
  const branchStrategy = useCodeStore(s => s.branchStrategy);
  const techStack = useCodeStore(s => s.techStack);
  const llmProviderId = useLlmStore(s => s.providerId);
  const llmApiKey = useLlmStore(s => s.apiKey);
  const llmSelectedModel = useLlmStore(s => s.selectedModel);
  const llmSetProviderId = useLlmStore(s => s.setProviderId);
  const llmSetApiKey = useLlmStore(s => s.setApiKey);
  const llmSetSelectedModel = useLlmStore(s => s.setSelectedModel);

  const [windowLlm, setWindowLlm] = useState(() => loadWindowLlm(windowId));

  const setWindowProvider = useCallback((id) => {
    setWindowLlm((prev) => ({ ...prev, providerId: id, selectedModel: null }));
    if (isPrimary) {
      llmSetProviderId(id);
    } else {
      persistWindowLlm(windowId, 'providerId', id);
      persistWindowLlm(windowId, 'selectedModel', null);
    }
  }, [isPrimary, windowId, llmSetProviderId]);

  const setWindowApiKey = useCallback((key) => {
    setWindowLlm((prev) => ({ ...prev, apiKey: key }));
    if (isPrimary) llmSetApiKey(key);
    else persistWindowLlm(windowId, 'apiKey', key);
  }, [isPrimary, windowId, llmSetApiKey]);

  const setWindowSelectedModel = useCallback((model) => {
    setWindowLlm((prev) => ({ ...prev, selectedModel: model }));
    if (isPrimary) llmSetSelectedModel(model);
    else persistWindowLlm(windowId, 'selectedModel', model);
  }, [isPrimary, windowId, llmSetSelectedModel]);

  useEffect(() => {
    if (!isPrimary) return;
    const s = useLlmStore.getState();
    setWindowLlm((prev) =>
      prev.providerId !== s.providerId || prev.apiKey !== s.apiKey || prev.selectedModel !== s.selectedModel
        ? { providerId: s.providerId, apiKey: s.apiKey, selectedModel: s.selectedModel }
        : prev
    );
  }, [isPrimary, llmProviderId, llmApiKey, llmSelectedModel]);

  useEffect(() => {
    useCodeStore.getState().setSpaceId(spaceId);
  }, [spaceId]);

  useEffect(() => {
    usePlanStore.getState().initSpace(spaceId);
  }, [spaceId]);

  useEffect(() => {
    const handleObjectsCleared = () => {
      setMessages([]);
      setPlanMessages([]);
      setCodeMessages([]);
    };
    window.addEventListener('space-objects-cleared', handleObjectsCleared);
    return () => window.removeEventListener('space-objects-cleared', handleObjectsCleared);
  }, []);

  const [showGithubPanel, setShowGithubPanel] = useState(false);
  const [repos, setRepos] = useState([]);
  const [showRepos, setShowRepos] = useState(false);
  const [showNewRepoInput, setShowNewRepoInput] = useState(false);
  const [newRepoName, setNewRepoName] = useState('');
  const [showBranchPrompt, setShowBranchPrompt] = useState(false);
  const [branchNameInput, setBranchNameInput] = useState('');
  const [availableBranches, setAvailableBranches] = useState([]);
  const [branchFetching, setBranchFetching] = useState(false);
  const [showProviderModal, setShowProviderModal] = useState(false);
  const [showApiKeyInput, setShowApiKeyInput] = useState(false);
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [providerModels, setProviderModels] = useState([]);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [modelFetchError, setModelFetchError] = useState(null);
  const [showManualModelInput, setShowManualModelInput] = useState(false);
  const [manualModelInput, setManualModelInput] = useState('');
  const [pendingProviderId, setPendingProviderId] = useState(null);
  const [showModelDropdown, setShowModelDropdown] = useState(false);
  const [authError, setAuthError] = useState(null);
  const [pushNotification, setPushNotification] = useState(null);
  const [associatedCount, setAssociatedCount] = useState(0);
  const [scanProgress, setScanProgress] = useState(null);

  const llmMessages = chatMode === 'plan' ? planMessages : codeMessages;

  // Plan/code modes need an LLM provider API key before the user can send.
  // Group mode is a real-time chat and never locked.
  const llmLocked = chatMode !== 'group' && !windowLlm.apiKey;

  // Hide the "create a 3D diagram" suggestion once the user has actually
  // asked for a diagram in this plan conversation.
  const planRequestedDiagram = planMessages.some(
    (m) => m.role === 'user' && /diagram/i.test(m.content || '')
  );

  useEffect(() => {
    if (!spaceId || !isOpen || chatMode !== 'group') return;

    setMessages([]);
    setHasMore(false);
    oldestTimestampRef.current = null;
    liveKeysRef.current = new Set();

    const unsubHistory = onSocket('chat:history', (msgs) => {
      const mapped = (msgs || []).map((m) => ({ key: m.id, ...m }));
      liveKeysRef.current = new Set(mapped.map((m) => m.key));
      setMessages(mapped);
      if (mapped.length > 0) {
        oldestTimestampRef.current = mapped[0].timestamp || null;
      }
    });

    const unsubMessage = onSocket('chat:message', (msg) => {
      const wrapped = { ...msg, key: msg.id };
      setMessages((prev) => {
        if (prev.some((m) => m.key === wrapped.key || m.key === msg._tempKey)) return prev;
        const next = [...prev, wrapped];
        if (next.length > 0) {
          oldestTimestampRef.current = next[0].timestamp || null;
        }
        return next;
      });
      liveKeysRef.current.add(msg.id);
    });

      emitSocket('chat:join', { spaceId });

    return () => {
      emitSocket('chat:leave', { spaceId });
      unsubHistory();
      unsubMessage();
      setMessages([]);
      liveKeysRef.current = new Set();
    };
  }, [spaceId, isOpen, chatMode]);

  useEffect(() => {
    if (isOpen && isNearBottomRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: streaming ? 'auto' : 'smooth' });
    }
  }, [messages, planMessages, codeMessages, isOpen, streaming]);

  const handleScroll = useCallback(async () => {
    const el = scrollContainerRef.current;
    if (!el) return;
    isNearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (chatMode === 'group' && el.scrollTop < 60 && hasMore && !loadingMore) {
      setHasMore(false);
    }
  }, [spaceId, chatMode, hasMore, loadingMore]);

  useEffect(() => {
    const timer = setTimeout(() => persistMessages(spaceId, 'plan', planMessages, windowId), 1000);
    return () => clearTimeout(timer);
  }, [spaceId, planMessages, windowId]);

  useEffect(() => {
    const timer = setTimeout(() => persistMessages(spaceId, 'code', codeMessages, windowId), 1000);
    return () => clearTimeout(timer);
  }, [spaceId, codeMessages, windowId]);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || !spaceId) return;
    setSending(true);
    try {
      emitSocket('chat:message', { spaceId, text });
      setInput('');
      isNearBottomRef.current = true;
    } catch (err) {
      console.warn('[chat] Failed to send message:', err.message);
    } finally {
      setSending(false);
    }
  }, [input, spaceId, user]);

  const handlePlanSend = useCallback(async () => {
    const text = input.trim();
    if (!text || streaming) return;

    setLlmError(null);
    setInput('');
    isNearBottomRef.current = true;

    const userMessage = { role: 'user', content: text };
    const updatedMessages = [...planMessages, userMessage];
    setPlanMessages(updatedMessages);

    // Warm the content-store worker (off the main thread) before tools run.
    // Include any cached repo contents so search_code/grep can scan the repo.
    const _csState = useCodeStore.getState();
    const cachedContents = (_csState.repoFileTree && Object.keys(_csState.repoFileContents || {}).length > 0)
      ? _csState.repoFileContents
      : null;
    populateContentStoreWorker(cachedContents, null);

    const sceneObjects = useObjectsStore.getState().objects;
    const zenMessages = await buildZenMessages({
      llmMessages: updatedMessages,
      sceneObjects,
      modelId: windowLlm.selectedModel,
      signal: new AbortController().signal,
    });

    setStreaming(true);
    streamingRef.current = '';
    streamingMsgKeyRef.current = `llm-stream-${Date.now()}`;
    const currentStreamKey = streamingMsgKeyRef.current;

    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    try {
      const githubContext = selectedRepo && selectedBranch ? {
        owner: selectedRepo.owner?.login || selectedRepo.owner,
        repo: selectedRepo.name,
        branch: selectedBranch,
        token: getGithubToken(),
        commitSha: getSpaceCommitSha(spaceId),
      } : null;

      const planResponse = await sendWithRetrieval({
        messages: zenMessages,
        signal: abortController.signal,
        llmConfig: { providerId: windowLlm.providerId, apiKey: windowLlm.apiKey, selectedModel: windowLlm.selectedModel },
        githubContext,
        fileTree: useCodeStore.getState().repoFileTree || [],
        fileSizes: useCodeStore.getState().fileSizes,
        sceneObjects,
        onChunk: (delta, fullText) => {
          streamingRef.current = fullText;
          if (!rafPendingRef.current) {
            rafPendingRef.current = true;
            requestAnimationFrame(() => {
              rafPendingRef.current = false;
              const snapshot = streamingRef.current;
              setPlanMessages((prev) => {
                const streamMsg = {
                  key: currentStreamKey,
                  role: 'assistant',
                  content: snapshot,
                  streaming: true,
                };
                const withoutStreaming = prev.filter(m => m.key !== currentStreamKey);
                return [...withoutStreaming, streamMsg];
              });
            });
          }
        },
        onRetrieval: ({ chunkIds, round }) => {
          console.log(`[ToolRound] Plan tool round ${round}: ${chunkIds.join(', ')}`);
        },
        onToolProgress: ({ tool, index, total, status }) => {
          const currentText = streamingRef.current || '';
          let label;
          if (status === 'complete') {
            label = 'Processing results...';
          } else if (status === 'error') {
            label = `Tool ${tool} failed`;
          } else {
            label = `Executing ${tool} (${index}/${total})...`;
          }
          streamingRef.current = currentText + '\n' + label;
          if (!rafPendingRef.current) {
            rafPendingRef.current = true;
            requestAnimationFrame(() => {
              rafPendingRef.current = false;
              const snapshot = streamingRef.current;
              setPlanMessages((prev) => {
                const streamMsg = {
                  key: currentStreamKey,
                  role: 'assistant',
                  content: snapshot,
                  streaming: true,
                };
                const withoutStreaming = prev.filter(m => m.key !== currentStreamKey);
                return [...withoutStreaming, streamMsg];
              });
            });
          }
        },
      });

      const finalText = planResponse;

      // Plan tasks are managed via plan tools (create_plan, add_task, etc.)
      // which write directly to the plan store. No need to save to text objects.

      const blocks = extractMerfolkBlocks(finalText);

      setPlanMessages((prev) => {
        const finalMsg = {
          key: currentStreamKey,
          role: 'assistant',
          content: finalText,
          streaming: false,
          diagramCreated: false,
        };
        const withoutStream = prev.filter(m => m.key !== currentStreamKey);
        return [...withoutStream, finalMsg];
      });

      if (blocks.length > 0) {
        let enrichedBlocks = blocks;
        if (selectedRepo && selectedBranch) {
          const repoContext = {
            owner: selectedRepo.owner?.login || selectedRepo.owner,
            repo: selectedRepo.name,
            branch: selectedBranch,
            token: getGithubToken(),
            fileTree: useCodeStore.getState().repoFileTree || [],
            fileContents: useCodeStore.getState().repoFileContents || {},
          };
          enrichedBlocks = await Promise.all(
            blocks.map((block) => enrichPlanMerfolk(block, repoContext)),
          );
        }
        const rendered = await renderMerfolkToScene(enrichedBlocks, spaceId, user);
        if (rendered) {
          setPlanMessages((prev) =>
            prev.map(m =>
              m.key === currentStreamKey
                ? { ...m, diagramCreated: true }
                : m
            )
          );
          const enrichedMarkdown = enrichedBlocks
            .map((block) => '```merfolk\n' + block + '\n```')
            .join('\n\n');
          onDiagramGenerated?.({
            markdown: enrichedMarkdown,
            repo: selectedRepo,
          });
        }
      }
    } catch (err) {
      if (err.name === 'AbortError') return;
      const msg = err.message || 'Failed to reach LLM. Check your connection.';
      if (isFreeUsageLimit(err)) {
        setLlmError('Free usage limit reached for Opencode Zen. This free tier is shared per-IP across hoverchart, so its daily budget is often exhausted. Switch to a paid provider in the model picker (Anthropic, Google, or Nvidia) for reliable use.');
      } else {
        setLlmError(msg);
      }
      if (/401|auth|invalid api key/i.test(msg)) {
        setAuthError(msg);
      }
      setPlanMessages((prev) => prev.filter(m => m.key !== currentStreamKey));
    } finally {
      setStreaming(false);
      streamingRef.current = '';
      abortControllerRef.current = null;
    }
  }, [input, streaming, planMessages, spaceId, user, windowLlm, selectedRepo, selectedBranch, onDiagramGenerated]);

  const handleCodeSend = useCallback(async () => {
    const text = input.trim();
    if (!text || streaming) return;

    setLlmError(null);
    setInput('');
    isNearBottomRef.current = true;

    const userMessage = { role: 'user', content: text };
    const updatedMessages = [...codeMessages, userMessage];
    setCodeMessages(updatedMessages);

    const sceneObjects = useObjectsStore.getState().objects;

    setStreaming(true);
    streamingRef.current = '';
    const currentStreamKey = `code-stream-${Date.now()}`;
    streamingMsgKeyRef.current = currentStreamKey;

    // Create a workflow ticket for this LLM task
    let workflowTicket = null;
    try {
      workflowTicket = await createTicket({
        spaceId,
        userId: user?.uid || user?.sub,
        userName: user?.name || 'Anonymous',
        userPicture: user?.picture || null,
        promptPreview: text.slice(0, 120),
        promptFull: text,
      });
      emitTicketCreated(workflowTicket);
    } catch (ticketErr) {
      console.warn('[CodeSend] Failed to create workflow ticket:', ticketErr.message);
    }

    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    try {
      let repoContext = null;
      if (selectedRepo && selectedBranch) {
        const _cs = useCodeStore.getState();
        // The search corpus lives in the content store (persisted to IndexedDB).
        // If it already holds repo: entries, we don't need to re-fetch the
        // contents from GitHub just to search — reuse the cached tree.
        let storeHasRepoContents = false;
        try {
          await waitForContentStoreHydration();
          const store = getContentStore();
          for (const id of store.entries.keys()) {
            if (id.startsWith('repo:')) { storeHasRepoContents = true; break; }
          }
        } catch { /* treat store as empty */ }
        if (_cs.repoFileTree && (Object.keys(_cs.repoFileContents || {}).length > 0 || storeHasRepoContents)) {
          repoContext = {
            fileTree: _cs.repoFileTree,
            fileContents: _cs.repoFileContents || {},
            fileSizes: _cs.fileSizes || null,
          };
          console.log(`[CodeSend] Using cached repo context: ${repoContext.fileTree.length} files, ${Object.keys(repoContext.fileContents).length} contents${storeHasRepoContents && !_cs.repoFileContents ? ' (corpus from content store)' : ''}`);
          // Warm the content-store worker with the cached contents so
          // search_code/grep are fast and run off the main thread. The fetch
          // path below does the same; without it the worker is empty and the
          // first search pays a full on-demand index inside its timeout race,
          // then falls back to a freezing main-thread scan.
          if (Object.keys(_cs.repoFileContents || {}).length > 0) {
            populateContentStoreWorker(_cs.repoFileContents, null)
              .catch((err) => console.warn('[CodeSend] populateContentStoreWorker failed:', err));
          }
        } else {
          const token = getGithubToken();
          if (token) {
            const owner = selectedRepo.owner?.login || selectedRepo.owner;
            const repoName = selectedRepo.name;
            const branchName = selectedBranch;
            console.log(_cs.repoFileTree
              ? '[CodeSend] Cached tree present but contents empty — refetching repo context from GitHub...'
              : '[CodeSend] Fetching repo context from GitHub...');
            repoContext = await fetchRepoContext(token, owner, repoName, branchName);
            useCodeStore.getState().setRepoContext(repoContext.fileTree, repoContext.fileContents);
            console.log(`[CodeSend] Fetched: ${repoContext.fileTree.length} files, ${Object.keys(repoContext.fileContents).length} contents`);
            // Rebuild + persist the search corpus (IndexedDB) so search_code has
            // full-text to scan even when no scan has run yet. Fire-and-forget.
            if (Object.keys(repoContext.fileContents).length > 0) {
              populateContentStoreWorker(repoContext.fileContents, null)
                .catch((err) => console.warn('[CodeSend] populateContentStoreWorker failed:', err));
            }
          }
        }
      }

      console.log('[CodeSend] Building code gen messages...');
      const workflowCtx = buildWorkflowContext(spaceId, user?.uid || user?.sub);
      const codeGenMessages = await buildCodeGenMessages({
        userRequest: text,
        sceneObjects,
        techStack,
        repoContext,
        corrections: correctionsRef.current,
        workflowContext: workflowCtx,
      });
      const systemLen = codeGenMessages[0]?.content?.length || 0;
      console.log(`[CodeSend] Messages built. System message: ${systemLen} chars`);

      const githubContext = selectedRepo && selectedBranch ? {
        owner: selectedRepo.owner?.login || selectedRepo.owner,
        repo: selectedRepo.name,
        branch: selectedBranch,
        token: getGithubToken(),
        commitSha: getSpaceCommitSha(spaceId),
      } : null;

      console.log('[CodeSend] Sending to LLM...');
      const codeResponse = await sendWithRetrieval({
        messages: codeGenMessages,
        signal: abortController.signal,
        llmConfig: { providerId: windowLlm.providerId, apiKey: windowLlm.apiKey, selectedModel: windowLlm.selectedModel },
        githubContext,
        fileTree: repoContext?.fileTree || [],
        fileSizes: useCodeStore.getState().fileSizes,
        sceneObjects,
        onChunk: (delta, fullText) => {
          streamingRef.current = fullText;
          if (!rafPendingRef.current) {
            rafPendingRef.current = true;
            requestAnimationFrame(() => {
              rafPendingRef.current = false;
              const snapshot = streamingRef.current;
              setCodeMessages((prev) => {
                const streamMsg = {
                  key: currentStreamKey,
                  role: 'assistant',
                  content: snapshot,
                  streaming: true,
                };
                const withoutStreaming = prev.filter(m => m.key !== currentStreamKey);
                return [...withoutStreaming, streamMsg];
              });
            });
          }
        },
        onRetrieval: ({ chunkIds, round }) => {
          console.log(`[ToolRound] Tool execution round ${round}: ${chunkIds.join(', ')}`);
        },
        onToolProgress: ({ tool, index, total, status }) => {
          const currentText = streamingRef.current || '';
          let label;
          if (status === 'complete') {
            label = 'Processing results...';
          } else if (status === 'error') {
            label = `Tool ${tool} failed`;
          } else {
            label = `Executing ${tool} (${index}/${total})...`;
          }
          streamingRef.current = currentText + '\n' + label;
          if (!rafPendingRef.current) {
            rafPendingRef.current = true;
            requestAnimationFrame(() => {
              rafPendingRef.current = false;
              const snapshot = streamingRef.current;
              setCodeMessages((prev) => {
                const streamMsg = {
                  key: currentStreamKey,
                  role: 'assistant',
                  content: snapshot,
                  streaming: true,
                };
                const withoutStreaming = prev.filter(m => m.key !== currentStreamKey);
                return [...withoutStreaming, streamMsg];
              });
            });
          }
        },
      });

      const codeBlocks = extractCodeBlocks(codeResponse);
      const mergedBlocks = codeBlocks;
      const csState = useCodeStore.getState();

      if (mergedBlocks.length > 0 && selectedRepo && selectedBranch) {
        // The code-gen prompt requires SEARCH/REPLACE markers for existing
        // files. Apply them against the current file content here so the
        // pending-change diff shows the real edit (imports preserved) instead
        // of raw marker text, and so a later push writes the merged file rather
        // than the markers. Applied blocks are marked fullContent so the push
        // service can skip its own SEARCH/REPLACE pass.
        const repoFileTree = repoContext?.fileTree || [];
        const appliedBlocks = [];
        const getExistingContent = async (filePath) => {
          const cached = csState.repoFileContents?.[filePath];
          if (cached) return cached;
          const token = getGithubToken();
          const owner = selectedRepo.owner?.login || selectedRepo.owner;
          if (!token || !owner) return null;
          try {
            return await fetchFileContent(owner, selectedRepo.name, filePath, token);
          } catch {
            return null;
          }
        };
        const autoDiffToPatch = (existing, proposed, filePath) => {
          const normExisting = existing.replace(/\r\n/g, '\n');
          const normProposed = proposed.replace(/\r\n/g, '\n');
          const hunks = diffToHunks(normExisting, normProposed);
          if (hunks.length === 0) return { noChange: true };
          const existingLines = normExisting.split('\n').length;
          const changedLines = hunks.reduce((sum, h) => sum + h.oldString.split('\n').length, 0);
          const isRewrite = existingLines > 0 && changedLines / existingLines >= 0.8;
          if (isRewrite) return null;
          const markers = buildSearchReplaceBlock(normExisting, normProposed, filePath);
          const applied = markers ? applySearchReplace(existing, markers) : null;
          return applied ? { code: applied } : null;
        };

        const corrections = [];

        for (const block of mergedBlocks) {
          if (!block.filePath || !block.code) {
            appliedBlocks.push(block);
            continue;
          }
          const existsInContents = !!csState.repoFileContents?.[block.filePath];
          const existsInTree = repoFileTree.includes(block.filePath);
          const isExisting = existsInContents || existsInTree;
          if (isExisting && hasSearchReplaceMarkers(block.code)) {
            const existing = await getExistingContent(block.filePath);
            const applied = existing ? applySearchReplace(existing, block.code) : null;
            if (applied) {
              appliedBlocks.push({ ...block, code: applied, fullContent: true });
              continue;
            }
            // applySearchReplace refused the block (whole-file SEARCH side, or a
            // SEARCH block that did not match the current content). When the
            // model dumps the ENTIRE file as the SEARCH side, the REPLACE side IS
            // its intended full file — recover it by diffing against the current
            // content into a minimal patch instead of keeping the marker blob.
            const markerBlocks = parseSearchReplaceBlocks(block.code);
            if (existing && markerBlocks.length === 1) {
              const searchLines = markerBlocks[0].search.replace(/\r\n/g, '\n').split('\n').length;
              const existingLines = existing.replace(/\r\n/g, '\n').split('\n').length;
              const isWholeFileSearch = existingLines > 0 && searchLines / existingLines >= 0.8;
              if (isWholeFileSearch) {
                const patch = autoDiffToPatch(existing, markerBlocks[0].replace, block.filePath);
                if (patch && patch.noChange) continue;
                if (patch && patch.code) {
                  appliedBlocks.push({ ...block, code: patch.code, fullContent: true });
                  continue;
                }
                // Genuine restructure or failed diff — keep raw for review but
                // flag it so the panel warns and push is blocked.
                appliedBlocks.push({ ...block, rawWholeFile: true });
                corrections.push(`Your proposal for ${block.filePath} re-emitted the ENTIRE file as the SEARCH side and was kept for manual review — it cannot be pushed. Use the edit tool (read_file first for the exact oldString) or output a narrow SEARCH/REPLACE hunk covering ONLY the changed lines.`);
                continue;
              }
            }
            console.warn(`[CodeSend] SEARCH/REPLACE did not match existing content for ${block.filePath} — keeping raw block for review`);
            corrections.push(`Your SEARCH/REPLACE for ${block.filePath} did not match the current file content. Re-read the file with read_file and provide hunks that match the exact current text (copy oldString verbatim, line numbers are stripped automatically).`);
          } else if (isExisting) {
            // Full-file block for an existing file: the model ignored the
            // "NEVER output an entire existing file" rule. Diff it against the
            // current content and emit a minimal SEARCH/REPLACE patch instead of
            // a whole-file proposal. Only a genuine restructure (>= 80% of the
            // file changed) or a block that diverges from the current content
            // stays as a whole-file proposal for explicit review.
            const existing = await getExistingContent(block.filePath);
            if (existing) {
              const patch = autoDiffToPatch(existing, block.code, block.filePath);
              if (patch && patch.noChange) continue;
              if (patch && patch.code) {
                appliedBlocks.push({ ...block, code: patch.code, fullContent: true });
                continue;
              }
              console.warn(`[CodeSend] Auto-diff of full-file block did not apply cleanly for ${block.filePath} — keeping raw block for review`);
              corrections.push(`Your full-file block for ${block.filePath} did not apply cleanly — it diverges from the current content and was kept for manual review. Use the edit tool with an exact oldString copied from read_file output, and verify each change applies.`);
            }
          }
          appliedBlocks.push(block);
        }

        correctionsRef.current = corrections;

        const { count } = await associateCodeWithScene(appliedBlocks, spaceId, user);
        setAssociatedCount(count);

        const newChanges = appliedBlocks
          .filter(block => block.filePath && block.code)
          .map(block => {
            const existsInContents = !!csState.repoFileContents?.[block.filePath];
            const existsInTree = repoFileTree.includes(block.filePath);
            const isExisting = existsInContents || existsInTree;
            return {
              filePath: block.filePath,
              original: csState.repoFileContents?.[block.filePath] || null,
              proposed: block.code,
              fullContent: !!block.fullContent,
              isWholeFileProposal: isExisting && !block.fullContent && (block.rawWholeFile || !hasSearchReplaceMarkers(block.code)),
              action: isExisting ? 'modify' : 'create',
              request: text,
            };
          });
        csState.addPendingChanges(newChanges);

        // Update workflow ticket with completed status and file diffs
        if (workflowTicket) {
          try {
            const ticketDiffs = newChanges.map((c) => ({
              filePath: c.filePath,
              original: c.original,
              proposed: c.proposed,
              action: c.action,
            }));
            const updated = await updateTicket(workflowTicket.id, {
              status: 'to_review',
              filesTouched: newChanges.map((c) => c.filePath),
              diffs: ticketDiffs,
            });
            emitTicketUpdated(updated);
          } catch (ticketErr) {
            console.warn('[CodeSend] Failed to update workflow ticket:', ticketErr.message);
          }
        }

        const modifiedCount = newChanges.filter(c => c.action === 'modify').length;
        const createdCount = newChanges.filter(c => c.action === 'create').length;
        const summary = `Generated ${mergedBlocks.length} file(s). ${modifiedCount} modified, ${createdCount} created. Review in the sidebar panel.`;

        const commitKey = `pending-${Date.now()}`;
        setCodeMessages((prev) => {
          const withoutStream = prev.filter(m => m.key !== currentStreamKey);
          return [...withoutStream, {
            key: commitKey,
            role: 'assistant',
            content: summary,
            streaming: false,
          }];
        });
      } else {
        const hasCode = /```[\s\S]+?```/.test(codeResponse);
        let displayContent;
        if (hasCode) {
          displayContent = codeResponse;
        } else if (codeResponse && codeResponse.trim().length > 20) {
          displayContent = codeResponse.trim() + '\n\n_No code blocks were generated. The LLM may need more specific instructions or different files._';
        } else {
          displayContent = 'No code blocks were generated. The tools could not locate the needed files, or the LLM did not produce code after reading them. Try:\n- Providing the exact file paths to modify\n- Reducing the scope of the change\n- Checking that the repository is connected and the files exist';
        }
        setCodeMessages((prev) => {
          const withoutStream = prev.filter(m => m.key !== currentStreamKey);
          return [...withoutStream, {
            key: currentStreamKey,
            role: 'assistant',
            content: displayContent,
            streaming: false,
          }];
        });
        // No file changes — mark ticket as committed (nothing to review)
        if (workflowTicket) {
          try {
            const updated = await updateTicket(workflowTicket.id, { status: 'committed' });
            emitTicketUpdated(updated);
          } catch (ticketErr) {
            console.warn('[CodeSend] Failed to update workflow ticket:', ticketErr.message);
          }
        }
      }
    } catch (err) {
      if (err.name === 'AbortError') return;
      const msg = err.message || 'Failed to reach LLM. Check your connection.';
      if (isFreeUsageLimit(err)) {
        setLlmError('Free usage limit reached for Opencode Zen. This free tier is shared per-IP across hoverchart, so its daily budget is often exhausted. Switch to a paid provider in the model picker (Anthropic, Google, or Nvidia) for reliable use.');
      } else {
        setLlmError(msg);
      }
      if (/401|auth|invalid api key/i.test(msg)) {
        setAuthError(msg);
      }
      setCodeMessages((prev) => prev.filter(m => m.key !== currentStreamKey));
    } finally {
      setStreaming(false);
      streamingRef.current = '';
      abortControllerRef.current = null;
    }
  }, [input, streaming, codeMessages, spaceId, user, selectedRepo, selectedBranch, techStack, windowLlm]);

  const handleKeyDown = useCallback(
    (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (chatMode === 'group') handleSend();
        else if (chatMode === 'plan') handlePlanSend();
        else handleCodeSend();
      }
    },
    [chatMode, handleSend, handlePlanSend, handleCodeSend]
  );

  const handleModeSwitch = useCallback((mode) => {
    setChatMode(mode);
    persistMode(spaceId, mode, windowId);
    setLlmError(null);
    setAuthError(null);
    setAssociatedCount(0);
    setPushNotification(null);
  }, [spaceId, windowId]);

  const handleStop = useCallback(() => {
    abortControllerRef.current?.abort();
  }, []);

  useEffect(() => {
    const isAuth = isGithubAuthenticated();
    if (isAuth !== githubConnected) {
      useCodeStore.getState().setGithubConnected(isAuth);
    }
  }, [githubConnected]);

  useEffect(() => {
    if (!showBranchPrompt) return;
    if (branchStrategy !== 'existing') return;

    const repo = selectedRepo;
    if (!repo) return;
    const owner = repo.owner?.login || repo.owner;
    const repoName = repo.name;
    const token = getGithubToken();
    if (!token) return;

    setBranchFetching(true);
    listBranches(token, owner, repoName)
      .then(branches => {
        setAvailableBranches(branches || []);
        if (branches?.length > 0) {
          setBranchNameInput(branches[0].name);
        }
      })
      .catch(() => setAvailableBranches([]))
      .finally(() => setBranchFetching(false));
  }, [showBranchPrompt, branchStrategy, selectedRepo]);

  const handleApiKeySubmit = useCallback(async () => {
    const key = apiKeyInput.trim();
    if (!key || !pendingProviderId) return;
    setFetchingModels(true);
    setModelFetchError(null);
    try {
      const models = await fetchModels(pendingProviderId, key);
      setWindowProvider(pendingProviderId);
      setWindowApiKey(key);
      setProviderModels(models);
      setShowApiKeyInput(false);
      setShowProviderModal(false);
      setAuthError(null);
      setLlmError(null);
      if (models.length > 0) {
        setShowModelDropdown(true);
      } else {
        setShowManualModelInput(true);
        setManualModelInput('');
      }
    } catch (err) {
      setModelFetchError(err.message);
    } finally {
      setFetchingModels(false);
    }
  }, [apiKeyInput, pendingProviderId, setWindowProvider, setWindowApiKey]);

  const handleManualModelSubmit = () => {
    const model = manualModelInput.trim();
    if (model) {
      setWindowSelectedModel(model);
    }
    setShowManualModelInput(false);
    setManualModelInput('');
    setProviderModels([]);
    setShowProviderModal(false);
    setShowModelDropdown(false);
  };

  const handleModelSelect = (modelId) => {
    setWindowSelectedModel(modelId);
    setProviderModels([]);
    setShowModelDropdown(false);
  };

  const handleModelButtonClick = useCallback(async () => {
    if (!windowLlm.providerId || !windowLlm.apiKey) {
      setShowProviderModal(true);
      return;
    }
    if (showModelDropdown) {
      setShowModelDropdown(false);
      return;
    }
    setFetchingModels(true);
    setModelFetchError(null);
    try {
      const models = await fetchModels(windowLlm.providerId, windowLlm.apiKey);
      setProviderModels(models);
      setShowModelDropdown(true);
    } catch (err) {
      setModelFetchError(err.message);
      setShowProviderModal(true);
    } finally {
      setFetchingModels(false);
    }
  }, [windowLlm.providerId, windowLlm.apiKey, showModelDropdown]);

  const handleGithubLogin = () => {
    window.location.href = getGithubOAuthUrl();
  };

  const handleFetchRepos = async () => {
    const token = getGithubToken();
    if (!token) return;
    try {
      const reposData = await fetchRepositories(token);
      setRepos(reposData);
    } catch { /* ignore */ }
  };

  const applyGithubSelection = (repo) => {
    const cs = useCodeStore.getState();
    cs.setGithubToken(getGithubToken());
    cs.setRepoOwner(repo.owner?.login || repo.owner);
    cs.setRepoName(repo.name);
  };

  const handleSelectRepo = async (repo) => {
    useCodeStore.getState().setSelectedRepo(repo);
    applyGithubSelection(repo);
    setShowRepos(false);
    setShowBranchPrompt(true);
    await scanRepoForDiagram(repo);
  };

  const scanRepoForDiagram = async (repo) => {
    if (!repo || !user || !spaceId || !onCreateObject) return;
    setScanProgress({ stage: 'Starting scan...', progress: 0 });
    let lastProgressTime = 0;
    window._connectionUpdateSkip = true;
    useDiagramStore.getState().clearConnectionsProgress();
    try {
      const result = await scanRepositoryAndGenerateDiagram(
        repo,
        onCreateObject,
        user,
        spaceId,
        uploadMarkdownToStorage,
        markdownDiagramService,
        (progress, stage) => {
          const now = Date.now();
          if (now - lastProgressTime > 300) {
            lastProgressTime = now;
            setScanProgress({ stage, progress });
          }
        }
      );
      if (result.success) {
        setScanProgress(null);
        if (result.contentIndex) useCodeStore.getState().setContentIndex(result.contentIndex);
        if (result.fileSizes) useCodeStore.getState().setFileSizes(result.fileSizes);
        if (result.importGraph) useCodeStore.getState().setImportGraph(result.importGraph);
        if (result.fileIndexByPath) useCodeStore.getState().setFileIndexByPath(result.fileIndexByPath);
        if (result.importIndexByFile) useCodeStore.getState().setImportIndexByFile(result.importIndexByFile);
        // Deferred so the scan-complete state can paint before the digest
        // snapshot (graphs + hierarchy + communities) is serialized.
        setTimeout(() => saveDiagramDigest(spaceId), 0);
        onDiagramGenerated?.({
          markdown: result.markdown,
          storageUrl: result.storageUrl,
          commitSha: result.commitSha,
          repo,
        });
        // If the scan pushed the tab close to its heap limit, surface a
        // non-blocking warning instead of silently heading toward an OOM crash.
        const highMemory = window._memoryPressureHigh;
        setPushNotification({
          type: highMemory ? 'warning' : 'success',
          message: highMemory
            ? `Diagram created (${result.objectsCreated} objects, ${result.connectionsCreated} connections) — memory usage is high. Consider a smaller repo or closing other tabs.`
            : `Diagram created: ${result.objectsCreated} objects, ${result.connectionsCreated} connections`,
        });
        setTimeout(() => setPushNotification(null), highMemory ? 10000 : 5000);

        const token = getGithubToken();
        if (token) {
          const owner = repo.owner?.login || repo.owner;
          const repoName = repo.name;
          const branch = selectedBranch || repo.default_branch || 'main';
          fetchRepoContext(token, owner, repoName, branch)
            .then(ctx => {
              const applyContext = async () => {
                useCodeStore.getState().setRepoContext(ctx.fileTree, ctx.fileContents);
                window._connectionUpdateSkip = false;
                // Fire-and-forget: populate content store in background via worker.
                // repoFileContents is sent in bounded batches so the main thread
                // is never blocked by a single large structured clone.
                populateContentStoreWorker(result.repoFileContents, result.markdown);
              };
              const waitForMount = () => {
                const progress = useDiagramStore.getState().renderProgress;
                const connProgress = useDiagramStore.getState().connectionsProgress;
                const objectsDone = !progress || progress.mounted >= progress.total;
                const connectionsDone = !connProgress || connProgress.mounted >= connProgress.total;
                if (objectsDone && connectionsDone) {
                  applyContext();
                } else {
                  requestIdleCallback(waitForMount);
                }
              };
              if (typeof requestIdleCallback === 'function') {
                requestIdleCallback(waitForMount);
              } else {
                setTimeout(waitForMount, 100);
              }
            })
            .catch(err => console.warn('[scan] fetchRepoContext failed:', err.message, err.stack));
        }
      } else {
        window._connectionUpdateSkip = false;
        setScanProgress(null);
        setPushNotification({ type: 'error', message: 'Failed to create diagram from repo.' });
        setTimeout(() => setPushNotification(null), 5000);
      }
    } catch (err) {
      window._connectionUpdateSkip = false;
      setScanProgress(null);
      setPushNotification({ type: 'error', message: `Scan error: ${err.message}` });
      setTimeout(() => setPushNotification(null), 5000);
    }
  };

  const handleCreateNewRepo = async () => {
    const name = newRepoName.trim();
    if (!name) return;
    const token = getGithubToken();
    if (!token) return;
    try {
      const res = await fetch('https://api.github.com/user/repos', {
        method: 'POST',
        headers: {
          Authorization: `token ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name, private: false, auto_init: true }),
      });
      if (!res.ok) throw new Error(`Failed to create repo: ${res.status}`);
      const repo = await res.json();
      useCodeStore.getState().setSelectedRepo(repo);
      applyGithubSelection(repo);
      setShowNewRepoInput(false);
      setNewRepoName('');
      setShowBranchPrompt(true);
      setPushNotification({ type: 'success', message: `Created repo ${name}` });
      setTimeout(() => setPushNotification(null), 3000);
    } catch (err) {
      setPushNotification({ type: 'error', message: err.message });
      setTimeout(() => setPushNotification(null), 5000);
    }
  };

  const handleBranchConfirm = async () => {
    const repo = selectedRepo;
    if (!repo) return;
    const owner = repo.owner?.login || repo.owner;
    const repoName = repo.name;
    const token = getGithubToken();
    if (!token) return;

    const strategy = branchStrategy;
    let branch = 'main';

    if (strategy === 'new') {
      const newBranch = branchNameInput.trim();
      if (!newBranch) return;
      try {
        const mainRef = await getBranchRef(token, owner, repoName, repo.default_branch || 'main');
        const sha = mainRef.data?.object?.sha;
        if (sha) await createBranchRef(token, owner, repoName, newBranch, sha);
        branch = newBranch;
      } catch (err) {
        setPushNotification({ type: 'error', message: `Failed to create branch: ${err.message}` });
        setTimeout(() => setPushNotification(null), 5000);
        return;
      }
    } else if (strategy === 'existing') {
      branch = branchNameInput.trim() || repo.default_branch || 'main';
    } else {
      branch = repo.default_branch || 'main';
    }

    useCodeStore.getState().setSelectedBranch(branch);
    setShowBranchPrompt(false);
    setBranchNameInput('');
    setPushNotification({ type: 'success', message: `Working in ${owner}/${repoName}:${branch}` });
    setTimeout(() => setPushNotification(null), 3000);
  };

  const getInputPlaceholder = () => {
    if (chatMode === 'group') return 'Send a message…';
    if (chatMode === 'plan') return 'Describe architecture or ask a question…';
    return 'Describe what code to generate…';
  };

  const getSendButtonLabel = () => {
    if (chatMode === 'group') return 'Send';
    if (chatMode === 'plan') return 'Send';
    return 'Generate code';
  };

  if (!isOpen) return null;

  return (
    <div
      className={`space-chat-window${isExpanded ? ' expanded' : ''}`}
      onClick={(e) => e.stopPropagation()}
      style={isExpanded ? undefined : {
        width: currentLayout.width,
        height: currentLayout.height,
        left: currentLayout.x,
        top: currentLayout.y,
      }}
    >
      <div className="space-chat-header" onMouseDown={handleDragStart}>
        <div className="space-chat-mode-toggle">
          <button
            className={`space-chat-mode-btn ${chatMode === 'group' ? 'active' : ''}`}
            onClick={() => handleModeSwitch('group')}
          >
            Group
          </button>
          <button
            className={`space-chat-mode-btn ${chatMode === 'plan' ? 'active' : ''}`}
            onClick={() => handleModeSwitch('plan')}
          >
            Plan
          </button>
          <button
            className={`space-chat-mode-btn ${chatMode === 'code' ? 'active' : ''}`}
            onClick={() => handleModeSwitch('code')}
          >
            Code
          </button>
        </div>
        <div className="space-chat-header-actions">
          {(chatMode === 'plan' || chatMode === 'code') && (
            <button
              className="space-chat-github-btn"
              onClick={() => setShowGithubPanel(v => !v)}
              title="GitHub"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 16 16"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
                style={{ display: 'block' }}
              >
                <path
                  d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"
                  fill={githubConnected ? '#6cc644' : '#ccc'}
                />
              </svg>
            </button>
          )}
          {onAddChat && (
            <button
              className="space-chat-new-window-btn"
              onClick={onAddChat}
              title="New chat window"
            >
              +
            </button>
          )}
          <button
            className="space-chat-expand"
            onClick={() => setIsExpanded(v => !v)}
            title={isExpanded ? 'Collapse' : 'Expand'}
          >
            {isExpanded ? '⤡' : '⤢'}
          </button>
          {onClose && (
            <button
              className="space-chat-close"
              onClick={onClose}
              title="Close chat"
            >
              ✕
            </button>
          )}
        </div>
      </div>

      {!isExpanded && (
        <>
          <div className="space-chat-resize-handle space-chat-resize-left" onMouseDown={(e) => handleResizeStart('left', e)} />
          <div className="space-chat-resize-handle space-chat-resize-right" onMouseDown={(e) => handleResizeStart('right', e)} />
          <div className="space-chat-resize-handle space-chat-resize-bottom" onMouseDown={(e) => handleResizeStart('bottom', e)} />
          <div className="space-chat-resize-handle space-chat-resize-corner" onMouseDown={(e) => handleResizeStart('corner', e)} />
        </>
      )}

      {showBranchPrompt && (
        <div className="space-chat-modal-overlay" onClick={() => {}}>
          <div className="space-chat-modal" onClick={e => e.stopPropagation()}>
            <div className="space-chat-modal-title">Commit Strategy</div>
            <div className="space-chat-modal-body">
              <p>How should code be committed to {selectedRepo?.name}?</p>
              <div className="space-chat-modal-options">
                <label className="space-chat-modal-option">
                  <input
                    type="radio"
                    name="branchStrategy"
                    checked={branchStrategy === 'main'}
                    onChange={() => useCodeStore.getState().setBranchStrategy('main')}
                  />
                  <span>Commit to main/master</span>
                </label>
                <label className="space-chat-modal-option">
                  <input
                    type="radio"
                    name="branchStrategy"
                    checked={branchStrategy === 'new'}
                    onChange={() => useCodeStore.getState().setBranchStrategy('new')}
                  />
                  <span>Create new branch</span>
                </label>
                <label className="space-chat-modal-option">
                  <input
                    type="radio"
                    name="branchStrategy"
                    checked={branchStrategy === 'existing'}
                    onChange={() => useCodeStore.getState().setBranchStrategy('existing')}
                  />
                  <span>Select existing branch</span>
                </label>
              </div>
              {branchStrategy === 'new' && (
                <input
                  className="space-chat-modal-input"
                  type="text"
                  placeholder="New branch name…"
                  value={branchNameInput}
                  onChange={e => setBranchNameInput(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') handleBranchConfirm(); }}
                  autoFocus
                />
              )}
              {branchStrategy === 'existing' && (
                <select
                  className="space-chat-modal-input space-chat-modal-select"
                  value={branchNameInput}
                  onChange={e => setBranchNameInput(e.target.value)}
                  disabled={branchFetching}
                  autoFocus
                >
                  {branchFetching ? (
                    <option value="">Loading branches…</option>
                  ) : availableBranches.length === 0 ? (
                    <option value="">No branches found</option>
                  ) : (
                    availableBranches.map(b => (
                      <option key={b.name} value={b.name}>{b.name}</option>
                    ))
                  )}
                </select>
              )}
              <div className="space-chat-modal-actions">
                <button className="space-chat-modal-btn primary" onClick={handleBranchConfirm}>
                  Confirm
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* GitHub Panel */}
      {showGithubPanel && (chatMode === 'plan' || chatMode === 'code') && (
        <div className="space-chat-github-panel">
          {!githubConnected ? (
            <button className="github-login-button" onClick={handleGithubLogin}>
              Connect to GitHub
            </button>
          ) : (
            <div className="space-chat-github-connected">
              {selectedRepo ? (
                <div className="space-chat-repo-info">
                  <span className="space-chat-repo-name">
                    {selectedRepo.full_name || selectedRepo.name}
                  </span>
                  <span className="space-chat-branch-name">:{selectedBranch}</span>
                  <button
                    className="space-chat-small-btn"
                    onClick={() => setShowBranchPrompt(true)}
                    title="Switch branch"
                  >
                    Switch
                  </button>
                </div>
              ) : (
                <div className="space-chat-repo-select">
                  <button
                    className="space-chat-small-btn"
                    onClick={() => { handleFetchRepos(); setShowRepos(v => !v); }}
                  >
                    {showRepos ? 'Hide repos' : 'Select repo'}
                  </button>
                  <button
                    className="space-chat-small-btn"
                    onClick={() => setShowNewRepoInput(v => !v)}
                  >
                    New repo
                  </button>
                  {showRepos && (
                    <div className="space-chat-repo-list">
                      {repos.map(repo => (
                        <button
                          key={repo.id}
                          className="space-chat-repo-item"
                          onClick={() => handleSelectRepo(repo)}
                        >
                          {repo.name}
                        </button>
                      ))}
                    </div>
                  )}
                  {showNewRepoInput && (
                    <div className="space-chat-new-repo">
                      <input
                        type="text"
                        placeholder="Repository name"
                        value={newRepoName}
                        onChange={e => setNewRepoName(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') handleCreateNewRepo(); }}
                      />
                      <button className="space-chat-small-btn" onClick={handleCreateNewRepo}>
                        Create
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      <div
        className="space-chat-messages"
        ref={scrollContainerRef}
        onScroll={handleScroll}
      >
        {chatMode === 'group' && (
          <>
            {loadingMore && <div className="space-chat-load-more">Loading…</div>}
            {!loadingMore && !hasMore && messages.length > 0 && (
              <div className="space-chat-load-more">Beginning of chat</div>
            )}
            {messages.length === 0 && !loadingMore && (
              <div className="space-chat-empty">No messages yet. Say hello!</div>
            )}
            {messages.map((msg) => {
              const ownId = user ? user.uid : getGuestId();
              const isOwn = msg.userId === ownId;
              return (
                <div key={msg.key} className={`space-chat-message ${isOwn ? 'own' : ''}`}>
                  {!isOwn && (
                    <div className="space-chat-avatar" title={msg.displayName || 'User'}>
                      {msg.photoURL ? (
                        <img src={msg.photoURL} alt={msg.displayName} referrerPolicy="no-referrer"
                          onError={(e) => { e.target.style.display = 'none'; e.target.nextSibling.style.display = 'flex'; }}
                        />
                      ) : null}
                      <span style={{ display: msg.photoURL ? 'none' : 'flex' }}>
                        {senderInitials(msg.displayName)}
                      </span>
                    </div>
                  )}
                  <div className="space-chat-bubble-wrap">
                    {!isOwn && <div className="space-chat-name">{msg.displayName || 'User'}</div>}
                    <div className="space-chat-bubble">{msg.text}</div>
                  </div>
                </div>
              );
            })}
          </>
        )}

        {(chatMode === 'plan' || chatMode === 'code') && (
          <>
            {llmMessages.length === 0 && !streaming && (
              <div className="space-chat-empty">
                {chatMode === 'plan' ? (
                  <>
                    {!githubConnected && (
                      <>
                        Click the Github button to login to Github and scan your code repositories.
                        <br /><br />
                      </>
                    )}
                    {!planRequestedDiagram && (
                      <>
                        {!githubConnected ? 'Or ' : ''}Give me requirements for your architecture to create a 3D diagram to your specifications.
                      </>
                    )}
                  </>
                ) : (
                  <>
                    Generate code from your architecture diagram.
                    <br /><br />
                    {techStack ? (
                      <>Tech stack: {techStack}</>
                    ) : (
                      <>Tech stack will be auto-detected from your codebase.</>
                    )}
                  </>
                )}
              </div>
            )}
            {llmError && <div className="space-chat-error">{llmError}</div>}
            {authError && (
              <div className="space-chat-auth-error">
                <span>Invalid API key for {windowLlm.providerId ? PROVIDERS.find(p => p.id === windowLlm.providerId)?.name || windowLlm.providerId : 'provider'}</span>
                <button
                  className="space-chat-auth-error-btn"
                  onClick={() => {
                    setAuthError(null);
                    setLlmError(null);
                    setShowProviderModal(true);
                  }}
                >
                  Configure
                </button>
                <button
                  className="space-chat-auth-error-dismiss"
                  onClick={() => setAuthError(null)}
                >
                  ✕
                </button>
              </div>
            )}
            {streaming && !llmMessages.some(m => m.streaming) && (
              <div className="space-chat-loading">
                <span className="space-chat-spinner" />
                <span>Thinking…</span>
              </div>
            )}
            {pushNotification && (
              <div className={`space-chat-notification ${pushNotification.type}`}>
                {pushNotification.message}
              </div>
            )}
            {scanProgress && (
              <div className="space-chat-notification info">
                <span className="space-chat-spinner" />
                <span>{scanProgress.stage} ({scanProgress.progress}%)</span>
              </div>
            )}
            {associatedCount > 0 && chatMode === 'code' && (
              <div className="space-chat-notification success">
                Associated {associatedCount} file(s) with objects
              </div>
            )}
            {llmMessages.map((msg) => {
              if (msg.role === 'system') {
                return (
                  <div key={msg.key} className={`space-chat-commit ${msg.type === 'commit-error' ? 'error' : ''}`}>
                    {msg.type === 'commit' ? '✓' : '✕'} {msg.content}
                  </div>
                );
              }
              const isUser = msg.role === 'user';
              return (
                <div key={msg.key} className={`space-chat-message ${isUser ? 'own llm-user' : 'llm-assistant'}`}>
                  <div className="space-chat-bubble-wrap">
                    <div className="space-chat-bubble">
                      {msg.content}
                      {msg.streaming && <span className="space-chat-streaming-cursor" />}
                    </div>
                    {msg.diagramCreated && (
                      <div className="space-chat-merfolk-badge">✦ 3D diagram created</div>
                    )}
                    {msg.codeCreated && (
                      <div className="space-chat-merfolk-badge">✦ Code generated</div>
                    )}
                  </div>
                </div>
              );
            })}
          </>
        )}
        <div ref={bottomRef} />
      </div>

      {(chatMode === 'plan' || chatMode === 'code') && (
        <div className="space-chat-model-bar">
          <button
            className="space-chat-model-btn"
            onClick={() => setShowProviderModal(true)}
            disabled={streaming}
          >
            {windowLlm.providerId
              ? PROVIDERS.find(p => p.id === windowLlm.providerId)?.name || windowLlm.providerId
              : 'Provider'}
            <span className="space-chat-model-arrow">▼</span>
          </button>
          <button
            className="space-chat-model-btn"
            onClick={handleModelButtonClick}
            disabled={streaming || fetchingModels}
          >
            {fetchingModels
              ? 'Loading…'
              : windowLlm.selectedModel || 'Model'}
            <span className="space-chat-model-arrow">▼</span>
          </button>
        </div>
      )}

      {/* Provider Selection Modal */}
      {showProviderModal && !showApiKeyInput && (
        <div className="space-chat-modal-overlay" onClick={() => setShowProviderModal(false)}>
          <div className="space-chat-modal" onClick={e => e.stopPropagation()}>
            <div className="space-chat-modal-title">Select Provider</div>
            <div className="space-chat-provider-list">
              {PROVIDERS.map(p => (
                <button
                  key={p.id}
                  className={`space-chat-provider-option ${windowLlm.providerId === p.id ? 'selected' : ''}`}
                    onClick={() => {
                    setPendingProviderId(p.id);
                    setApiKeyInput(windowLlm.providerId === p.id && windowLlm.apiKey ? windowLlm.apiKey : '');
                    setShowApiKeyInput(true);
                  }}
                >
                  {p.name}
                  {windowLlm.providerId === p.id && windowLlm.apiKey && <span className="space-chat-model-check">✓</span>}
                </button>
              ))}
            </div>
            {windowLlm.providerId === 'opencode-zen' && (
              <div className="space-chat-provider-hint">
                Opencode Zen's free models share a per-IP daily usage cap across hoverchart and can hit limits quickly. A paid provider (Anthropic, Google, or Nvidia) is recommended for reliable use.
              </div>
            )}
            <div className="space-chat-modal-actions">
              <button className="space-chat-modal-btn" onClick={() => setShowProviderModal(false)}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* API Key Input Modal */}
      {showApiKeyInput && (
        <div className="space-chat-modal-overlay" onClick={() => { setShowApiKeyInput(false); setShowProviderModal(false); }}>
          <div className="space-chat-modal" onClick={e => e.stopPropagation()}>
            <div className="space-chat-modal-title">
              {PROVIDERS.find(p => p.id === pendingProviderId)?.name || 'Provider'} API Key
            </div>
            <div className="space-chat-modal-body">
              <input
                className="space-chat-modal-input"
                type="password"
                placeholder={`Enter your ${PROVIDERS.find(p => p.id === pendingProviderId)?.name || ''} API key…`}
                value={apiKeyInput}
                onChange={e => setApiKeyInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleApiKeySubmit(); }}
                autoFocus
              />
              {modelFetchError && <div className="space-chat-provider-error">{modelFetchError}</div>}
            </div>
            <div className="space-chat-modal-actions">
              <button className="space-chat-modal-btn" onClick={() => { setShowApiKeyInput(false); setShowProviderModal(false); setModelFetchError(null); }}>Back</button>
              <button className="space-chat-modal-btn primary" onClick={handleApiKeySubmit} disabled={!apiKeyInput.trim() || fetchingModels}>
                {fetchingModels ? 'Loading…' : 'Fetch Models'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Model Selection Modal (loading) */}
      {fetchingModels && !modelFetchError && (
        <div className="space-chat-modal-overlay">
          <div className="space-chat-modal">
            <div className="space-chat-modal-title">Loading models…</div>
          </div>
        </div>
      )}

      {/* Model Selection Dropdown */}
      {showModelDropdown && providerModels.length > 0 && (
        <div className="space-chat-modal-overlay" onClick={() => { setShowModelDropdown(false); setProviderModels([]); }}>
          <div className="space-chat-modal" onClick={e => e.stopPropagation()}>
            <div className="space-chat-modal-title">Select Model</div>
            <div className="space-chat-provider-list">
              {providerModels.map(m => (
                <button
                  key={m.id}
                  className={`space-chat-provider-option ${windowLlm.selectedModel === m.id ? 'selected' : ''}`}
                  onClick={() => handleModelSelect(m.id)}
                >
                  {m.name}
                  {windowLlm.selectedModel === m.id && <span className="space-chat-model-check">✓</span>}
                </button>
              ))}
            </div>
            {windowLlm.providerId === 'opencode-zen' && /free|-free$|-free\b/i.test(windowLlm.selectedModel || '') && (
              <div className="space-chat-provider-hint">
                Free Zen models share a per-IP daily usage cap across hoverchart and can hit limits quickly. A paid provider (Anthropic, Google, or Nvidia) is recommended for reliable use.
              </div>
            )}
            <div className="space-chat-modal-actions">
              <button className="space-chat-modal-btn" onClick={() => { setShowModelDropdown(false); setProviderModels([]); }}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {showManualModelInput && (
        <div className="space-chat-modal-overlay" onClick={() => setShowManualModelInput(false)}>
          <div className="space-chat-modal" onClick={e => e.stopPropagation()}>
            <div className="space-chat-modal-title">Enter Model Name</div>
            <div className="space-chat-modal-body">
              <p>Could not fetch model list. Type your model name manually:</p>
              <input
                className="space-chat-modal-input"
                type="text"
                placeholder="e.g., gpt-4o, claude-3-opus-20240229"
                value={manualModelInput}
                onChange={e => setManualModelInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleManualModelSubmit(); }}
                autoFocus
              />
              <div className="space-chat-modal-actions">
                <button className="space-chat-modal-btn" onClick={() => setShowManualModelInput(false)}>Cancel</button>
                <button className="space-chat-modal-btn primary" onClick={handleManualModelSubmit} disabled={!manualModelInput.trim()}>
                  Confirm
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      <div
        className={`space-chat-input-row${llmLocked ? ' space-chat-input-row--locked' : ''}`}
        onClick={llmLocked ? () => setShowProviderModal(true) : undefined}
        role={llmLocked ? 'button' : undefined}
        aria-disabled={llmLocked || undefined}
        title={llmLocked ? 'Connect to provider' : undefined}
      >
        <textarea
          ref={textareaRef}
          className="space-chat-input"
          rows={1}
          placeholder={llmLocked ? 'connect to provider' : getInputPlaceholder()}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          maxLength={chatMode === 'group' ? 500 : 4000}
          disabled={chatMode !== 'group' && (streaming || llmLocked)}
          tabIndex={llmLocked ? -1 : undefined}
        />
        <button
          className="space-chat-send"
          onClick={
            streaming
              ? handleStop
              : (chatMode === 'group' ? handleSend : chatMode === 'plan' ? handlePlanSend : handleCodeSend)
          }
          disabled={streaming ? false : (llmLocked || !input.trim() || (chatMode === 'group' ? sending : streaming))}
          title={streaming ? 'Stop' : getSendButtonLabel()}
        >
          {streaming ? '◼' : '➤'}
        </button>
      </div>
    </div>
  );
};

SpaceChat.displayName = 'SpaceChat';
export default SpaceChat;
