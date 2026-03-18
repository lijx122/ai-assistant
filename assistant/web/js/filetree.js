// ─────────────────────────────────────────────
// 文件树功能
// ─────────────────────────────────────────────

// 跟踪脏文件（未保存修改）的集合
if (!state.dirtyFiles) {
  state.dirtyFiles = new Set();
}

// 设置文件脏标记状态
function setFileDirty(path, isDirty) {
  if (isDirty) {
    state.dirtyFiles.add(path);
  } else {
    state.dirtyFiles.delete(path);
  }
  // 重新渲染文件树以更新标记
  renderFileTree();
}

// 检查文件是否脏
function isFileDirty(path) {
  return state.dirtyFiles.has(path);
}

// 加载指定目录的子项（惰性加载）
async function loadTreeNode(path = '.') {
  if (!state.currentWs) return null;

  try {
    const data = await api(`/api/files?workspaceId=${state.currentWs.id}&path=${encodeURIComponent(path)}`);
    if (!data || !data.success) return null;

    // 创建或更新节点
    const node = {
      path: path,
      name: path === '.' ? state.currentWs.name : path.split('/').pop(),
      type: 'directory',
      children: data.files.map(f => f.path),
      loaded: true,
      expanded: state.expandedPaths.has(path)
    };

    // 更新当前目录节点
    state.treeNodes.set(path, node);

    // 添加/更新子节点
    for (const file of data.files) {
      const existing = state.treeNodes.get(file.path);
      state.treeNodes.set(file.path, {
        path: file.path,
        name: file.name,
        type: file.isDirectory ? 'directory' : 'file',
        language: file.language,
        children: existing?.children || [],
        loaded: existing?.loaded || false,
        expanded: state.expandedPaths.has(file.path)
      });
    }

    return node;
  } catch (err) {
    devError('TREE', 'Failed to load node:', err);
    return null;
  }
}

// 初始化加载根目录
async function loadFileTree() {
  if (!state.currentWs) return;
  await loadTreeNode('.');
  renderFileTree();
}

// 切换目录展开/折叠状态
async function toggleFolder(path) {
  const node = state.treeNodes.get(path);
  if (!node || node.type !== 'directory') return;

  if (node.expanded) {
    // 折叠
    node.expanded = false;
    state.expandedPaths.delete(path);
  } else {
    // 展开：如果未加载子项，先加载
    if (!node.loaded) {
      await loadTreeNode(path);
    }
    node.expanded = true;
    state.expandedPaths.add(path);
  }

  renderFileTree();
}

// 刷新文件树（清空缓存重新加载）
async function refreshFileTree() {
  state.treeNodes.clear();
  state.expandedPaths = new Set(['.']);
  await loadFileTree();
}

// 渲染文件树（VSCode 树形模式）
function renderFileTree() {
  const container = $('file-tree');
  if (!container) return;

  const rootNode = state.treeNodes.get('.');
  if (!rootNode) {
    container.innerHTML = '<p class="text-[10px] font-mono opacity-30 text-center py-4">选择工作区加载文件</p>';
    return;
  }

  // 添加拖拽相关样式和事件
  container.style.userSelect = 'none';
  container.setAttribute('ondragover', 'handleRootDragOver(event)');
  container.setAttribute('ondragleave', 'handleRootDragLeave(event)');
  container.setAttribute('ondrop', 'handleRootDrop(event)');

  container.innerHTML = renderTreeNode('.', 0);
  lucide.createIcons({ nodes: [container] });
}

// 递归渲染单个树节点及其子项
function renderTreeNode(path, depth) {
  const node = state.treeNodes.get(path);
  if (!node) return '';

  const isDir = node.type === 'directory';
  const isExpanded = node.expanded;
  const isSelected = state.selectedTreePath === path;

  // 展开/折叠箭头图标
  const arrowIcon = isDir
    ? (isExpanded ? 'chevron-down' : 'chevron-right')
    : 'chevron-right'  // 文件也给一个默认值，虽然不会显示;
  const arrowClass = isDir ? 'cursor-pointer hover:opacity-70' : 'opacity-0 pointer-events-none';

  // 文件/目录图标
  const fileIcon = isDir
    ? (isExpanded ? 'folder-open' : 'folder')
    : (node.language ? getFileIcon(node.name) : 'file');
  const iconColor = isDir ? 'text-amber-400' : 'opacity-50';

  // 缩进计算
  const indentPx = depth * 12;

  // 脏标记：未保存的文件显示 •
  const dirtyIndicator = (!isDir && isFileDirty(node.path)) ? '<span class="w-1.5 h-1.5 rounded-full bg-amber-500 ml-1" title="有未保存的更改"></span>' : '';

  // 渲染当前节点
  const dragAttrs = `draggable="true" ondragstart="handleDragStart(event, '${path}')" ondragend="handleDragEnd(event)"`;
  const dropAttrs = isDir
    ? `ondragover="handleDragOver(event, '${path}')" ondragleave="handleDragLeave(event, '${path}')" ondrop="handleDrop(event, '${path}')"`
    : '';

  let html = `
    <div class="tree-node-wrapper" ${dropAttrs}>
      <div class="tree-node group flex items-center gap-1 px-2 py-1 rounded-lg hover:bg-white/50 cursor-pointer transition-colors ${isSelected ? 'bg-white/70' : ''}"
           style="padding-left: ${8 + indentPx}px"
           data-path="${path}"
           ${dragAttrs}
           onclick="onTreeNodeClick(event, '${path}', ${isDir})">
        <span class="tree-arrow w-4 h-4 flex items-center justify-center ${arrowClass}"
              onclick="event.stopPropagation(); toggleFolder('${path}')">
          <i data-lucide="${arrowIcon}" class="w-3 h-3 opacity-50"></i>
        </span>
        <i data-lucide="${fileIcon}" class="w-4 h-4 ${iconColor}"></i>
        <span class="text-[11px] truncate flex-1 tree-name">${node.name}</span>
        ${dirtyIndicator}
        <button class="tree-menu-btn opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-white/70 transition-all"
                onclick="event.stopPropagation(); showTreeMenu(event, '${path}', ${isDir})">
          <i data-lucide="more-horizontal" class="w-3 h-3 opacity-50"></i>
        </button>
      </div>
  `;

  // 如果是展开的目录，递归渲染子项
  if (isDir && isExpanded && node.children) {
    // 按目录在前、文件在后排序
    const sortedChildren = node.children
      .map(childPath => state.treeNodes.get(childPath))
      .filter(Boolean)
      .sort((a, b) => {
        if (a.type !== b.type) {
          return a.type === 'directory' ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
      });

    for (const child of sortedChildren) {
      html += renderTreeNode(child.path, depth + 1);
    }
  }

  html += '</div>';
  return html;
}

// 树节点点击处理
function onTreeNodeClick(event, path, isDir) {
  if (isDir) {
    // 点击目录：切换展开/折叠
    toggleFolder(path);
  } else {
    // 点击文件：选中并打开
    state.selectedTreePath = path;
    renderFileTree(); // 重新渲染以更新选中状态
    openFile(path);
  }
}

// 获取文件图标
function getFileIcon(filename) {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  const iconMap = {
    'ts': 'file-code',
    'tsx': 'file-code',
    'js': 'file-code',
    'jsx': 'file-code',
    'json': 'file-json',
    'html': 'file-code',
    'css': 'file-code',
    'md': 'file-text',
    'txt': 'file-text',
    'py': 'file-code',
    'java': 'file-code',
    'go': 'file-code',
    'rs': 'file-code',
    'php': 'file-code',
    'rb': 'file-code'
  };
  return iconMap[ext] || 'file';
}

// ═══════════════════════════════════════════════════════════════
// 树节点菜单
// ═══════════════════════════════════════════════════════════════

function showTreeMenu(event, path, isDirectory) {
  event.stopPropagation();
  hideTreeMenu();

  const node = state.treeNodes.get(path);
  if (!node) return;

  const menu = document.createElement('div');
  menu.id = 'tree-context-menu';
  menu.className = 'file-context-menu';
  menu.style.cssText = `
    position: fixed;
    z-index: 1000;
    background: rgba(255,255,255,0.98);
    backdrop-filter: blur(20px);
    border: 1px solid rgba(0,0,0,0.08);
    box-shadow: 0 10px 40px -10px rgba(0,0,0,0.2);
    border-radius: 0.75rem;
    padding: 0.25rem 0;
    min-width: 160px;
    max-height: 400px;
    overflow-y: auto;
  `;

  // 计算菜单位置 - 使用 clientX/Y 更可靠
  const isMouseEvent = event.clientX !== undefined;
  let left = isMouseEvent ? event.clientX : (event.target?.getBoundingClientRect()?.left || 0);
  let top = isMouseEvent ? event.clientY + 4 : (event.target?.getBoundingClientRect()?.bottom + 4 || 0);

  // 确保菜单不超出视口
  if (left + 180 > window.innerWidth) left = Math.max(10, left - 180);
  if (top + 300 > window.innerHeight) top = Math.max(10, top - 300);

  menu.style.left = left + 'px';
  menu.style.top = top + 'px';

  // 全局 action 注册表
  window._menuActions = {};
  let actionId = 0;
  function registerAction(fn) {
    const id = 'action_' + (actionId++);
    window._menuActions[id] = fn;
    return id;
  }

  const hasClipboard = state.clipboard && state.clipboard.path;
  const canPaste = hasClipboard && state.clipboard.path !== path;

  // 生成菜单项
  const menuItems = [];

  // 基础操作组
  menuItems.push(
    { icon: 'copy', label: '复制路径', actionId: registerAction(() => { copyPath(path); hideTreeMenu(); }) },
    { icon: 'file-code', label: '复制绝对路径', actionId: registerAction(() => { copyAbsolutePath(path); hideTreeMenu(); }) },
    { separator: true },
    { icon: 'pencil', label: '重命名', actionId: registerAction(() => { startRenameTreeNode(path); hideTreeMenu(); }) }
  );

  if (isDirectory) {
    menuItems.push(
      { icon: 'copy', label: '复制文件夹', actionId: registerAction(() => { copyNode(path, true); hideTreeMenu(); }) },
      { icon: 'scissors', label: '剪切', actionId: registerAction(() => { cutNode(path, true); hideTreeMenu(); }) }
    );
  } else {
    menuItems.push(
      { icon: 'copy', label: '复制文件', actionId: registerAction(() => { copyNode(path, false); hideTreeMenu(); }) },
      { icon: 'scissors', label: '剪切', actionId: registerAction(() => { cutNode(path, false); hideTreeMenu(); }) }
    );
  }

  // 粘贴选项（仅目录或有剪贴板内容时显示）
  if (canPaste) {
    menuItems.push(
      { icon: 'clipboard', label: '粘贴', actionId: registerAction(() => { pasteNode(path); hideTreeMenu(); }) }
    );
  }

  menuItems.push(
    { icon: 'trash-2', label: '删除', danger: true, actionId: registerAction(() => { confirmDeleteTreeNode(path, isDirectory); hideTreeMenu(); }) }
  );

  // 目录特有操作
  if (isDirectory) {
    menuItems.push({ separator: true });
    menuItems.push(
      { icon: 'file-plus', label: '新建文件', actionId: registerAction(() => { showInlineNewFileInput(path); hideTreeMenu(); }) },
      { icon: 'folder-plus', label: '新建文件夹', actionId: registerAction(() => { showInlineNewFolderInput(path); hideTreeMenu(); }) }
    );
  }

  // 终端操作
  menuItems.push({ separator: true });
  const dirPath = isDirectory ? path : (path.includes('/') ? path.substring(0, path.lastIndexOf('/')) : '.');
  menuItems.push(
    { icon: 'terminal', label: '在终端中打开', actionId: registerAction(() => { openInTerminal(dirPath); hideTreeMenu(); }) }
  );

  // 渲染菜单 - 使用 actionId 而非 toString()
  menu.innerHTML = menuItems.map(item => {
    if (item.separator) {
      return '<div class="h-px bg-slate-200 my-1 mx-2"></div>';
    }
    const dangerClass = item.danger ? 'text-red-500 hover:bg-red-50' : 'hover:bg-slate-50';
    return `
      <div class="px-3 py-2 text-[11px] cursor-pointer flex items-center gap-2 transition-colors ${dangerClass}"
           onclick="window._menuActions['${item.actionId}'] && window._menuActions['${item.actionId}']()">
        <i data-lucide="${item.icon}" class="w-3.5 h-3.5 opacity-60"></i>
        <span>${item.label}</span>
      </div>
    `;
  }).join('');

  document.body.appendChild(menu);
  lucide.createIcons({ nodes: [menu] });

  // 点击其他地方关闭菜单
  setTimeout(() => {
    document.addEventListener('click', hideTreeMenu, { once: true });
  }, 10);
}

function hideTreeMenu() {
  document.querySelectorAll('.file-context-menu').forEach(m => m.remove());
}

// ═══════════════════════════════════════════════════════════════
// 剪贴板操作
// ═══════════════════════════════════════════════════════════════

async function copyPath(path) {
  await navigator.clipboard.writeText(path);
  showToast('已复制路径');
}

async function copyAbsolutePath(path) {
  if (!state.currentWs) return;
  const ws = state.currentWs;
  const absPath = ws.root_path + '/' + path;
  await navigator.clipboard.writeText(absPath);
  showToast('已复制绝对路径');
}

async function copyNode(path, isDirectory) {
  state.clipboard = { type: 'copy', path, isDirectory };
  showToast(isDirectory ? '已复制文件夹' : '已复制文件');
}

function cutNode(path, isDirectory) {
  state.clipboard = { type: 'cut', path, isDirectory };
  // 设置视觉反馈
  const node = document.querySelector(`.tree-node[data-path="${path}"]`);
  if (node) node.style.opacity = '0.5';
  showToast(isDirectory ? '已剪切文件夹' : '已剪切文件');
}

async function pasteNode(targetPath) {
  if (!state.clipboard || !state.currentWs) return;

  const { type, path: srcPath, isDirectory } = state.clipboard;
  const fileName = srcPath.split('/').pop();
  const dstPath = targetPath === '.' ? fileName : `${targetPath}/${fileName}`;

  // 检查是否在相同位置
  const srcDir = srcPath.includes('/') ? srcPath.substring(0, srcPath.lastIndexOf('/')) : '.';
  if (srcDir === targetPath && type === 'cut') {
    showToast('已在该目录中');
    return;
  }

  try {
    if (type === 'copy') {
      // 生成不重复的目标路径
      const finalDstPath = await generateUniquePath(dstPath);
      const data = await api('/api/files/copy', {
        method: 'POST',
        body: {
          workspaceId: state.currentWs.id,
          srcPath,
          dstPath: finalDstPath
        }
      });

      if (data?.success) {
        showToast('已粘贴');
        await refreshTreeNode(targetPath);
        // 展开目标目录
        const targetNode = state.treeNodes.get(targetPath);
        if (targetNode) {
          targetNode.expanded = true;
          state.expandedPaths.add(targetPath);
        }
        renderFileTree();
      } else {
        alert('粘贴失败: ' + (data?.error || '未知错误'));
      }
    } else if (type === 'cut') {
      // 移动操作
      await performMove(srcPath, targetPath);
      // 清除剪贴板
      clearClipboard();
    }
  } catch (err) {
    devError('TREE', 'Paste failed:', err);
    alert('粘贴失败: ' + err.message);
  }
}

function clearClipboard() {
  if (state.clipboard?.path) {
    const node = document.querySelector(`.tree-node[data-path="${state.clipboard.path}"]`);
    if (node) node.style.opacity = '';
  }
  state.clipboard = null;
}

async function generateUniquePath(basePath) {
  const node = state.treeNodes.get(basePath);
  if (!node) return basePath;

  // 提取文件名和扩展名
  const name = basePath.split('/').pop();
  const lastDot = name.lastIndexOf('.');
  const baseName = lastDot > 0 ? name.substring(0, lastDot) : name;
  const ext = lastDot > 0 ? name.substring(lastDot) : '';
  const dir = basePath.substring(0, basePath.length - name.length);

  let counter = 1;
  let newPath = basePath;
  while (state.treeNodes.has(newPath)) {
    counter++;
    newPath = dir + baseName + '_copy' + (counter > 2 ? counter - 1 : '') + ext;
  }
  return newPath;
}

// ═══════════════════════════════════════════════════════════════
// 内联新建输入框
// ═══════════════════════════════════════════════════════════════

function showInlineNewFileInput(parentPath) {
  const wrapper = document.querySelector(`.tree-node[data-path="${parentPath}"]`)?.closest('.tree-node-wrapper');
  if (!wrapper) return;

  // 展开父目录
  const node = state.treeNodes.get(parentPath);
  if (node && !node.expanded) {
    toggleFolder(parentPath);
  }

  // 创建输入框
  const inputContainer = document.createElement('div');
  inputContainer.className = 'inline-new-file-input py-1';
  inputContainer.style.paddingLeft = (parseInt(wrapper.querySelector('.tree-node').style.paddingLeft || '8px') + 12) + 'px';
  inputContainer.innerHTML = `
    <input type="text" placeholder="文件名..."
           class="px-2 py-1 text-[11px] bg-white rounded border border-slate-200 outline-none focus:border-oxygen-blue/50 w-32"
           onkeydown="handleInlineNewFileKey(event, '${parentPath}')"
           onblur="removeInlineNewFileInput()">
  `;

  wrapper.appendChild(inputContainer);
  const input = inputContainer.querySelector('input');
  input.focus();
}

function removeInlineNewFileInput() {
  setTimeout(() => {
    document.querySelectorAll('.inline-new-file-input').forEach(el => el.remove());
  }, 200);
}

function handleInlineNewFileKey(event, parentPath) {
  if (event.key === 'Enter') {
    const name = event.target.value.trim();
    if (name) {
      createNewFile(name, parentPath);
    }
    removeInlineNewFileInput();
  } else if (event.key === 'Escape') {
    removeInlineNewFileInput();
  }
}

function showInlineNewFolderInput(parentPath) {
  const wrapper = document.querySelector(`.tree-node[data-path="${parentPath}"]`)?.closest('.tree-node-wrapper');
  if (!wrapper) return;

  // 展开父目录
  const node = state.treeNodes.get(parentPath);
  if (node && !node.expanded) {
    toggleFolder(parentPath);
  }

  // 创建输入框
  const inputContainer = document.createElement('div');
  inputContainer.className = 'inline-new-folder-input py-1';
  inputContainer.style.paddingLeft = (parseInt(wrapper.querySelector('.tree-node').style.paddingLeft || '8px') + 12) + 'px';
  inputContainer.innerHTML = `
    <input type="text" placeholder="文件夹名..."
           class="px-2 py-1 text-[11px] bg-white rounded border border-slate-200 outline-none focus:border-oxygen-blue/50 w-32"
           onkeydown="handleInlineNewFolderKey(event, '${parentPath}')"
           onblur="removeInlineNewFolderInput()">
  `;

  wrapper.appendChild(inputContainer);
  const input = inputContainer.querySelector('input');
  input.focus();
}

function removeInlineNewFolderInput() {
  setTimeout(() => {
    document.querySelectorAll('.inline-new-folder-input').forEach(el => el.remove());
  }, 200);
}

function handleInlineNewFolderKey(event, parentPath) {
  if (event.key === 'Enter') {
    const name = event.target.value.trim();
    if (name) {
      createNewFolder(name, parentPath);
    }
    removeInlineNewFolderInput();
  } else if (event.key === 'Escape') {
    removeInlineNewFolderInput();
  }
}

// ═══════════════════════════════════════════════════════════════
// 终端操作
// ═══════════════════════════════════════════════════════════════

async function openInTerminal(dirPath) {
  if (!state.currentWs) return;

  // 获取工作区根路径
  const ws = state.currentWs;
  const fullPath = dirPath === '.' ? ws.root_path : `${ws.root_path}/${dirPath}`;

  // 如果没有终端，创建一个
  if (state.terminals.length === 0) {
    await createNewTerminal();
  }

  // 获取当前终端
  const terminal = state.terminals.find(t => t.id === state.currentTerminal) || state.terminals[0];
  if (!terminal) return;

  // 切换到终端面板
  sw('engineering');

  // 等待终端 ready 后发送 cd 命令
  setTimeout(() => {
    if (terminal.ws && terminal.ws.readyState === WebSocket.OPEN) {
      terminal.ws.send(`cd "${fullPath}"\n`);
    }
  }, 500);
}

// ═══════════════════════════════════════════════════════════════
// 文件操作
// ═══════════════════════════════════════════════════════════════

async function createNewFile(name, parentPath = '.') {
  if (!state.currentWs) return;

  const path = parentPath === '.' ? name : `${parentPath}/${name}`;

  try {
    const data = await api('/api/files', {
      method: 'POST',
      body: { workspaceId: state.currentWs.id, path, content: '' }
    });

    if (data?.success) {
      // 刷新父目录
      await refreshTreeNode(parentPath);
      // 自动打开新文件
      openFile(path);
    } else {
      alert('创建失败: ' + (data?.error || '未知错误'));
    }
  } catch (err) {
    devError('TREE', 'Failed to create file:', err);
    alert('创建失败: ' + err.message);
  }
}

async function createNewFolder(name, parentPath = '.') {
  if (!state.currentWs) return;

  const path = parentPath === '.' ? name : `${parentPath}/${name}`;

  try {
    const data = await api('/api/files/dir', {
      method: 'POST',
      body: { workspaceId: state.currentWs.id, path }
    });

    if (data?.success) {
      // 展开父目录并刷新
      const parentNode = state.treeNodes.get(parentPath);
      if (parentNode) {
        parentNode.expanded = true;
        state.expandedPaths.add(parentPath);
      }
      await refreshTreeNode(parentPath);
    } else {
      alert('创建失败: ' + (data?.error || '未知错误'));
    }
  } catch (err) {
    devError('TREE', 'Failed to create folder:', err);
    alert('创建失败: ' + err.message);
  }
}

// ═══════════════════════════════════════════════════════════════
// 顶部工具栏新建输入（兼容入口）
// ═══════════════════════════════════════════════════════════════

function showNewFileInput(parentPath = '.') {
  state.newFileTargetPath = parentPath || '.';
  const container = $('new-file-input-container');
  const input = $('new-file-input');
  const folderContainer = $('new-folder-input-container');

  if (folderContainer) folderContainer.classList.add('hidden');
  if (container) container.classList.remove('hidden');
  if (input) {
    input.value = '';
    input.focus();
  }
}

function hideNewFileInput() {
  // 延迟关闭，避免点击/回车触发顺序导致输入丢失
  setTimeout(() => {
    const container = $('new-file-input-container');
    const input = $('new-file-input');
    if (container) container.classList.add('hidden');
    if (input) input.value = '';
  }, 120);
}

async function handleNewFileKey(event) {
  if (event.key === 'Enter') {
    const input = event.target;
    const name = input.value.trim();
    if (name) {
      await createNewFile(name, state.newFileTargetPath || '.');
    }
    hideNewFileInput();
  } else if (event.key === 'Escape') {
    hideNewFileInput();
  }
}

function showNewFolderInput(parentPath = '.') {
  state.newFolderTargetPath = parentPath || '.';
  const container = $('new-folder-input-container');
  const input = $('new-folder-input');
  const fileContainer = $('new-file-input-container');

  if (fileContainer) fileContainer.classList.add('hidden');
  if (container) container.classList.remove('hidden');
  if (input) {
    input.value = '';
    input.focus();
  }
}

function hideNewFolderInput() {
  setTimeout(() => {
    const container = $('new-folder-input-container');
    const input = $('new-folder-input');
    if (container) container.classList.add('hidden');
    if (input) input.value = '';
  }, 120);
}

async function handleNewFolderKey(event) {
  if (event.key === 'Enter') {
    const input = event.target;
    const name = input.value.trim();
    if (name) {
      await createNewFolder(name, state.newFolderTargetPath || '.');
    }
    hideNewFolderInput();
  } else if (event.key === 'Escape') {
    hideNewFolderInput();
  }
}

async function refreshTreeNode(path) {
  const node = state.treeNodes.get(path);
  if (node) {
    node.loaded = false;
  }
  await loadTreeNode(path);
  renderFileTree();
}

function startRenameTreeNode(path) {
  const node = state.treeNodes.get(path);
  if (!node) return;

  const treeItem = document.querySelector(`.tree-node[data-path="${path}"]`);
  if (!treeItem) return;

  const nameSpan = treeItem.querySelector('.tree-name');
  if (!nameSpan) return;

  const oldName = node.name;

  // 创建输入框
  const input = document.createElement('input');
  input.type = 'text';
  input.value = oldName;
  input.className = 'px-1 py-0.5 text-[11px] bg-white rounded border border-oxygen-blue/50 outline-none flex-1';

  nameSpan.replaceWith(input);
  input.focus();
  input.select();

  const handleRename = async () => {
    const newName = input.value.trim();
    if (newName && newName !== oldName) {
      const parentPath = path.substring(0, path.length - oldName.length - 1) || '.';
      const newPath = parentPath === '.' ? newName : `${parentPath}/${newName}`;
      await renameTreeNode(path, newPath);
    }
    renderFileTree();
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      handleRename();
    } else if (e.key === 'Escape') {
      renderFileTree();
    }
  });

  input.addEventListener('blur', handleRename);
}

async function renameTreeNode(oldPath, newPath) {
  if (!state.currentWs) return;

  // 检查新名称是否与旧名称相同
  if (oldPath === newPath) return;

  // 检查新名称是否已存在
  if (state.treeNodes.has(newPath)) {
    alert('该名称已存在');
    return;
  }

  try {
    const data = await api('/api/files/rename', {
      method: 'PATCH',
      body: { workspaceId: state.currentWs.id, oldPath, newPath }
    });

    if (data?.success) {
      // 更新编辑器中的文件路径
      const openFile = state.editorFiles.find(f => f.path === oldPath);
      if (openFile) {
        openFile.path = newPath;
        updateEditorToolbar();
        renderEditorTabs();
      }
      // 刷新整个树
      await refreshFileTree();
    } else if (data?.error?.includes('already exists') || data?.code === 409) {
      alert('该名称已存在');
      renderFileTree();
    } else {
      alert('重命名失败: ' + (data?.error || '未知错误'));
      renderFileTree();
    }
  } catch (err) {
    devError('TREE', 'Failed to rename:', err);
    alert('重命名失败: ' + err.message);
    renderFileTree();
  }
}

function confirmDeleteTreeNode(path, isDirectory) {
  const node = state.treeNodes.get(path);
  const name = node?.name || path;
  const type = isDirectory ? '目录' : '文件';
  const warning = isDirectory ? '\n\n⚠️ 将删除该目录及其所有内容，此操作不可撤销。' : '\n\n此操作不可撤销。';

  if (confirm(`确认删除${type} "${name}"？${warning}`)) {
    deleteTreeNode(path);
  }
}

async function deleteTreeNode(path) {
  if (!state.currentWs) return;

  try {
    const data = await api(`/api/files?workspaceId=${state.currentWs.id}&path=${encodeURIComponent(path)}`, {
      method: 'DELETE'
    });

    if (data?.success) {
      // 如果删除的是已打开的文件，关闭编辑器
      const openFileIndex = state.editorFiles.findIndex(f => f.path === path);
      if (openFileIndex !== -1) {
        closeFile(state.editorFiles[openFileIndex].id);
      }
      // 从树中移除该节点及其所有子节点
      removeTreeNodeAndChildren(path);
      renderFileTree();
    } else {
      alert('删除失败: ' + (data?.error || '未知错误'));
    }
  } catch (err) {
    devError('TREE', 'Failed to delete:', err);
    alert('删除失败: ' + err.message);
  }
}

function removeTreeNodeAndChildren(path) {
  const node = state.treeNodes.get(path);
  if (node && node.children) {
    for (const childPath of node.children) {
      removeTreeNodeAndChildren(childPath);
    }
  }
  state.treeNodes.delete(path);
  state.expandedPaths.delete(path);
}

// 旧函数兼容（保留但内部调用新函数）
async function createNewFileOld(name) { await createNewFile(name, '.'); }
async function createNewFolderOld(name) { await createNewFolder(name, '.'); }

// ═══════════════════════════════════════════════════════════════
// 拖拽移动功能
// ═══════════════════════════════════════════════════════════════

let dragSource = null;        // 正在拖拽的路径
let dragOverTimer = null;     // 自动展开定时器
let dragOverTarget = null;    // 当前悬停的目标

function handleDragStart(e, path) {
  dragSource = path;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', path);

  // 延迟设置透明度，让拖拽镜像正常生成
  setTimeout(() => {
    const node = document.querySelector(`.tree-node[data-path="${path}"]`);
    if (node) node.style.opacity = '0.4';
  }, 0);
}

function handleDragEnd(e) {
  // 恢复所有节点样式
  document.querySelectorAll('.tree-node').forEach(node => {
    node.style.opacity = '';
  });
  document.querySelectorAll('.tree-node-wrapper').forEach(wrapper => {
    wrapper.classList.remove('drag-over');
  });

  clearTimeout(dragOverTimer);
  dragOverTimer = null;
  dragOverTarget = null;
  dragSource = null;
}

function handleDragOver(e, targetPath) {
  e.preventDefault();

  if (!dragSource || targetPath === dragSource) {
    e.dataTransfer.dropEffect = 'none';
    return;
  }

  // 不能拖到自身子目录
  if (targetPath !== '.' && dragSource.startsWith(targetPath + '/')) {
    e.dataTransfer.dropEffect = 'none';
    return;
  }

  e.dataTransfer.dropEffect = 'move';

  // 高亮目标
  const wrapper = e.currentTarget;
  if (dragOverTarget !== targetPath) {
    // 清除之前的高亮
    document.querySelectorAll('.tree-node-wrapper').forEach(w => w.classList.remove('drag-over'));
    // 添加新高亮
    wrapper.classList.add('drag-over');
    dragOverTarget = targetPath;

    // 清除之前的定时器
    clearTimeout(dragOverTimer);
    dragOverTimer = null;

    // 800ms 后自动展开目标目录
    const node = state.treeNodes.get(targetPath);
    if (node && node.type === 'directory' && !node.expanded) {
      dragOverTimer = setTimeout(() => {
        toggleFolder(targetPath);
      }, 800);
    }
  }
}

function handleDragLeave(e, targetPath) {
  const wrapper = e.currentTarget;
  // 检查是否真的离开了元素（而不是进入子元素）
  if (!wrapper.contains(e.relatedTarget)) {
    wrapper.classList.remove('drag-over');
    if (dragOverTarget === targetPath) {
      dragOverTarget = null;
      clearTimeout(dragOverTimer);
      dragOverTimer = null;
    }
  }
}

async function handleDrop(e, targetPath) {
  e.preventDefault();
  e.stopPropagation();

  clearTimeout(dragOverTimer);
  dragOverTimer = null;

  const wrapper = e.currentTarget;
  wrapper.classList.remove('drag-over');

  if (!dragSource || dragSource === targetPath) return;

  // 不能放到自身子目录
  if (targetPath !== '.' && dragSource.startsWith(targetPath + '/')) return;

  await performMove(dragSource, targetPath);
}

// 根目录拖拽处理
function handleRootDragOver(e) {
  e.preventDefault();
  if (!dragSource || dragSource === '.') {
    e.dataTransfer.dropEffect = 'none';
    return;
  }
  e.dataTransfer.dropEffect = 'move';
}

function handleRootDragLeave(e) {
  // 根目录不需要特殊处理
}

async function handleRootDrop(e) {
  e.preventDefault();
  if (!dragSource) return;
  await performMove(dragSource, '.');
}

// 执行移动操作
async function performMove(sourcePath, targetDirPath) {
  if (!state.currentWs) return;

  const fileName = sourcePath === '.' ? '' : sourcePath.split('/').pop();
  const newPath = targetDirPath === '.' ? fileName : `${targetDirPath}/${fileName}`;

  // 检查是否移动到相同位置
  const currentDir = sourcePath.includes('/') ? sourcePath.substring(0, sourcePath.lastIndexOf('/')) : '.';
  if (currentDir === targetDirPath) return;

  try {
    const data = await api('/api/files/move', {
      method: 'POST',
      body: {
        workspaceId: state.currentWs.id,
        oldPath: sourcePath,
        newPath: newPath
      }
    });

    if (data?.success) {
      // 更新编辑器中的文件路径
      const openFile = state.editorFiles.find(f => f.path === sourcePath);
      if (openFile) {
        openFile.path = newPath;
        updateEditorToolbar();
        renderEditorTabs();
      }
      // 刷新相关目录
      await refreshTreeNode(currentDir);
      if (targetDirPath !== currentDir) {
        await refreshTreeNode(targetDirPath);
      }
      // 展开目标目录
      const targetNode = state.treeNodes.get(targetDirPath);
      if (targetNode) {
        targetNode.expanded = true;
        state.expandedPaths.add(targetDirPath);
        renderFileTree();
      }
    } else if (data?.error) {
      alert('移动失败: ' + data.error);
    }
  } catch (err) {
    if (err.message && err.message.includes('409')) {
      // 409 冲突，显示覆盖确认
      const confirmed = confirm(`目标位置已存在 "${fileName}"，是否覆盖？`);
      if (confirmed) {
        await performMoveWithForce(sourcePath, targetDirPath, newPath);
      }
    } else {
      devError('TREE', 'Failed to move:', err);
      alert('移动失败: ' + err.message);
    }
  }
}

// 强制覆盖移动
async function performMoveWithForce(sourcePath, targetDirPath, newPath) {
  if (!state.currentWs) return;

  const currentDir = sourcePath.includes('/') ? sourcePath.substring(0, sourcePath.lastIndexOf('/')) : '.';

  try {
    const data = await api('/api/files/move', {
      method: 'POST',
      body: {
        workspaceId: state.currentWs.id,
        oldPath: sourcePath,
        newPath: newPath,
        force: true
      }
    });

    if (data?.success) {
      // 更新编辑器中的文件路径
      const openFile = state.editorFiles.find(f => f.path === sourcePath);
      if (openFile) {
        openFile.path = newPath;
        openFile.originalContent = openFile.content; // 重置修改状态
        openFile.isModified = false;
        updateEditorToolbar();
        renderEditorTabs();
      }
      // 如果目标文件已打开，关闭它
      const targetOpenFile = state.editorFiles.find(f => f.path === newPath && f.path !== sourcePath);
      if (targetOpenFile) {
        closeFile(targetOpenFile.id);
      }
      // 刷新相关目录
      await refreshTreeNode(currentDir);
      if (targetDirPath !== currentDir) {
        await refreshTreeNode(targetDirPath);
      }
      renderFileTree();
    } else {
      alert('移动失败: ' + (data?.error || '未知错误'));
    }
  } catch (err) {
    devError('TREE', 'Failed to move with force:', err);
    alert('移动失败: ' + err.message);
  }
}

// 添加右键菜单支持
document.addEventListener('DOMContentLoaded', () => {
  const fileTree = document.getElementById('file-tree');
  if (fileTree) {
    fileTree.addEventListener('contextmenu', (e) => {
      const nodeEl = e.target.closest('.tree-node');
      if (nodeEl) {
        e.preventDefault();
        const path = nodeEl.dataset.path;
        const node = state.treeNodes.get(path);
        if (node) {
          showTreeMenu(e, path, node.type === 'directory');
        }
      }
    });
  }
});
