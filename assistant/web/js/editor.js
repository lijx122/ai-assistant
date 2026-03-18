// ─────────────────────────────────────────────
// 文件编辑器 (Monaco Editor)
// ─────────────────────────────────────────────

// 初始化 Monaco Editor
function initMonacoEditor() {
  if (state.editor) return;
  if (typeof window.require === 'undefined') {
    devError('EDITOR', 'Monaco Editor loader not available');
    return;
  }

  window.require.config({ paths: { vs: 'https://cdn.jsdelivr.net/npm/monaco-editor@0.45.0/min/vs' } });

  window.require(['vs/editor/editor.main'], function () {
    const editorContainer = $('monaco-editor');
    if (!editorContainer) return;

    state.editor = window.monaco.editor.create(editorContainer, {
      value: '',
      language: 'plaintext',
      theme: 'vs-light',
      automaticLayout: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      fontSize: 14,
      fontFamily: 'JetBrains Mono, monospace',
      lineNumbers: 'on',
      roundedSelection: false,
      scrollbar: {
        useShadows: false,
        verticalHasArrows: false,
        horizontalHasArrows: false,
        vertical: 'auto',
        horizontal: 'auto'
      },
      padding: { top: 16, bottom: 16 }
    });

    // 监听内容变化，标记修改状态
    state.editor.onDidChangeModelContent(() => {
      const file = state.editorFiles.find(f => f.id === state.currentEditorFile);
      if (file) {
        const wasModified = file.isModified;
        file.isModified = state.editor.getValue() !== file.originalContent;
        // 同步到文件树脏标记状态
        if (wasModified !== file.isModified) {
          setFileDirty(file.path, file.isModified);
        }
        renderEditorTabs();
        updateEditorToolbar();
      }
    });

    // 绑定保存快捷键
    state.editor.addCommand(
      window.monaco.KeyMod.CtrlCmd | window.monaco.KeyCode.KeyS,
      () => saveCurrentFile()
    );
  });
}

// 打开文件
async function openFile(path) {
  if (!state.currentWs) return;

  // 检查文件是否已经打开
  const existingFile = state.editorFiles.find(f => f.path === path);
  if (existingFile) {
    switchToFile(existingFile.id);
    return;
  }

  try {
    const data = await api(`/api/files/content?workspaceId=${state.currentWs.id}&path=${encodeURIComponent(path)}`);
    if (!data || !data.success) {
      alert('无法打开文件: ' + (data?.error || '未知错误'));
      return;
    }

    const fileId = uid();
    const newFile = {
      id: fileId,
      path: data.path,
      content: data.content,
      originalContent: data.content,
      language: data.language || 'plaintext',
      isModified: false
    };

    state.editorFiles.push(newFile);
    switchToFile(fileId);
  } catch (err) {
    devError('EDITOR', 'Failed to open file:', err);
    alert('打开文件失败: ' + err.message);
  }
}

// 切换到指定文件
function switchToFile(fileId) {
  state.currentEditorFile = fileId;
  const file = state.editorFiles.find(f => f.id === fileId);
  if (!file) return;

  // 确保编辑器已初始化
  if (!state.editor) {
    initMonacoEditor();
    // 等待 Monaco 初始化完成
    setTimeout(() => switchToFile(fileId), 100);
    return;
  }

  // 隐藏空状态，显示编辑器和工具栏
  $('editor-empty').classList.add('hidden');
  $('monaco-editor').classList.remove('hidden');
  $('editor-toolbar').classList.remove('hidden');

  // 设置编辑器内容
  state.editor.setValue(file.content);
  window.monaco.editor.setModelLanguage(state.editor.getModel(), file.language);

  // 更新工具栏文件名
  updateEditorToolbar();
  renderEditorTabs();
  updateEditorStatus();
}

// 更新编辑器工具栏
function updateEditorToolbar() {
  const file = state.editorFiles.find(f => f.id === state.currentEditorFile);
  const filenameEl = $('editor-filename');
  const unsavedEl = $('unsaved-indicator');

  if (!file) {
    $('editor-toolbar').classList.add('hidden');
    return;
  }

  const filename = file.path.split('/').pop() || file.path;
  if (filenameEl) filenameEl.textContent = filename;

  // 更新未保存指示器
  if (unsavedEl) {
    if (file.isModified) {
      unsavedEl.classList.remove('hidden');
    } else {
      unsavedEl.classList.add('hidden');
    }
  }
}

// 显示保存状态提示
function showSaveStatus(message, isSuccess = true) {
  const statusEl = $('save-status');
  if (!statusEl) return;

  statusEl.textContent = message;
  statusEl.className = `text-[10px] font-mono transition-opacity ${isSuccess ? 'text-green-600' : 'text-red-500'}`;
  statusEl.style.opacity = '1';

  setTimeout(() => {
    statusEl.style.opacity = '0';
  }, 2000);
}

// 渲染编辑器 Tabs
function renderEditorTabs() {
  const container = $('editor-tabs');
  if (!container) return;

  if (state.editorFiles.length === 0) {
    container.innerHTML = '';
    return;
  }

  container.innerHTML = state.editorFiles.map(file => {
    const isActive = file.id === state.currentEditorFile;
    const filename = file.path.split('/').pop() || file.path;
    const modifiedIndicator = file.isModified ? '<span class="w-1.5 h-1.5 rounded-full bg-amber-500 ml-1"></span>' : '';

    return `
      <div class="editor-tab flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-medium ${isActive ? 'active' : 'bg-white/40'}"
           onclick="switchToFile('${file.id}')">
        <i data-lucide="file-code" class="w-3 h-3 opacity-60"></i>
        <span class="truncate max-w-[100px]">${filename}</span>
        ${modifiedIndicator}
        <button class="close-btn ml-1 p-0.5 rounded hover:bg-slate-200/50" onclick="closeFile('${file.id}', event)">
          <i data-lucide="x" class="w-3 h-3"></i>
        </button>
      </div>
    `;
  }).join('');

  lucide.createIcons({ nodes: [container] });
}

// 关闭文件
function closeFile(fileId, event) {
  if (event) event.stopPropagation();

  const fileIndex = state.editorFiles.findIndex(f => f.id === fileId);
  if (fileIndex === -1) return;

  const file = state.editorFiles[fileIndex];

  // 如果有未保存的修改，提示用户
  if (file.isModified) {
    if (!confirm(`文件 "${file.path}" 有未保存的修改，确定要关闭吗？`)) {
      return;
    }
  }

  state.editorFiles.splice(fileIndex, 1);

  // 如果关闭的是当前文件，切换到其他文件
  if (state.currentEditorFile === fileId) {
    if (state.editorFiles.length > 0) {
      const newIndex = Math.min(fileIndex, state.editorFiles.length - 1);
      switchToFile(state.editorFiles[newIndex].id);
    } else {
      // 没有文件了，显示空状态，隐藏工具栏
      state.currentEditorFile = null;
      if (state.editor) {
        state.editor.setValue('');
      }
      $('editor-empty').classList.remove('hidden');
      $('monaco-editor').classList.add('hidden');
      $('editor-toolbar').classList.add('hidden');
    }
  }

  renderEditorTabs();
}

// 保存当前文件
async function saveCurrentFile() {
  if (!state.currentEditorFile || !state.currentWs) {
    devError('EDITOR', '[Save] No current file or workspace');
    return;
  }

  const file = state.editorFiles.find(f => f.id === state.currentEditorFile);
  if (!file) {
    devError('EDITOR', '[Save] File not found:', state.currentEditorFile);
    return;
  }

  // 获取编辑器最新内容
  const content = state.editor.getValue();
  devLog('EDITOR', '[Save] Saving:', file.path, 'size:', content.length);

  try {
    const data = await api('/api/files/content', {
      method: 'PUT',
      body: {
        workspaceId: state.currentWs.id,
        path: file.path,
        content: content
      }
    });

    if (!data || !data.success) {
      devError('EDITOR', '[Save] Server error:', data?.error);
      showSaveStatus('保存失败', false);
      alert('保存失败: ' + (data?.error || '未知错误'));
      return;
    }

    devLog('EDITOR', '[Save] Verifying...');

    // 验证：重新读取文件内容对比（统一走 api，保持鉴权一致）
    const verifyData = await api(`/api/files/content?workspaceId=${state.currentWs.id}&path=${encodeURIComponent(file.path)}`);

    if (!verifyData || !verifyData.success) {
      devError('EDITOR', '[Save] Verification read failed:', verifyData?.error);
      showSaveStatus('保存失败', false);
      alert('保存验证失败: ' + (verifyData?.error || '读取失败'));
      return;
    }

    if (verifyData.content !== content) {
      devError('EDITOR', '[Save] Content mismatch after save');
      devLog('EDITOR', '[Save] Expected:', content.length, 'Got:', verifyData.content.length);
      showSaveStatus('保存验证失败', false);
      alert('保存验证失败：内容不一致');
      return;
    }

    devLog('EDITOR', '[Save] Verification passed');

    // 更新文件状态
    file.originalContent = content;
    file.content = content;
    file.isModified = false;

    // 清除文件树脏标记
    setFileDirty(file.path, false);

    // 更新 UI
    updateEditorToolbar();
    renderEditorTabs();
    showSaveStatus('已保存 ✓', true);
  } catch (err) {
    devError('EDITOR', '[Save] Exception:', err);
    showSaveStatus('保存失败', false);
    alert('保存失败: ' + err.message);
  }
}

// 更新编辑器状态显示
function updateEditorStatus() {
  const file = state.editorFiles.find(f => f.id === state.currentEditorFile);

  // 更新工具栏未保存指示器
  const unsavedEl = $('unsaved-indicator');
  if (unsavedEl && file) {
    if (file.isModified) {
      unsavedEl.classList.remove('hidden');
    } else {
      unsavedEl.classList.add('hidden');
    }
  }
}
