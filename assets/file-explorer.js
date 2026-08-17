(function () {
  var dsh = window.dshDesktop;
  var fs = dsh && dsh.fs;
  var ui = dsh && dsh.ui;
  if (!fs) return;

  function h(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  var root = h("div", "dfe-root");

  var collapsedStrip = h("div", "dfe-collapsed");
  var expandBtn = h("button", "dfe-expand-btn", "▶");
  var collapsedLabel = h("div", "dfe-collapsed-label", "资源管理器");
  collapsedStrip.appendChild(expandBtn);
  collapsedStrip.appendChild(collapsedLabel);

  var expanded = h("div", "dfe-expanded");

  var header = h("div", "dfe-header");
  var collapseBtn = h("button", "dfe-collapse-btn", "◀");
  collapseBtn.title = "折叠";
  var title = h("span", "dfe-title", "📁 资源管理器");
  var spacer = h("span", "dfe-spacer");
  var driveSel = document.createElement("select");
  driveSel.className = "dfe-drive";
  driveSel.title = "切换盘符";
  var refreshBtn = h("button", "dfe-btn", "刷新");
  header.appendChild(collapseBtn);
  header.appendChild(title);
  header.appendChild(spacer);
  header.appendChild(driveSel);
  header.appendChild(refreshBtn);

  var tabs = h("div", "dfe-tabs");
  var treeTab = h("button", "dfe-tab", "导航树");
  var previewTab = h("button", "dfe-tab", "文件预览");
  tabs.appendChild(treeTab);
  tabs.appendChild(previewTab);

  var treePanel = h("div", "dfe-tree-panel");
  var crumb = h("div", "dfe-crumb");
  var filterWrap = h("div", "dfe-filter");
  var filterInput = document.createElement("input");
  filterInput.placeholder = "过滤文件…";
  filterWrap.appendChild(filterInput);
  var tree = h("div", "dfe-tree");
  treePanel.appendChild(crumb);
  treePanel.appendChild(filterWrap);
  treePanel.appendChild(tree);

  var viewPanel = h("div", "dfe-view");

  expanded.appendChild(header);
  expanded.appendChild(tabs);
  expanded.appendChild(treePanel);
  expanded.appendChild(viewPanel);

  var resizer = h("div", "dfe-resizer");

  root.appendChild(collapsedStrip);
  root.appendChild(expanded);
  root.appendChild(resizer);
  document.body.appendChild(root);

  var cur = "";
  var curParent = "";
  var entries = [];
  var selected = null;
  var mdMode = "preview";
  var drives = [];
  var activeTab = "tree";
  var state = { collapsed: false, width: 360 };

  /* ---------- 工具 ---------- */
  function basename(p) {
    var parts = String(p || "").replace(/[\\/]+$/, "").split(/[\\/]/);
    return parts[parts.length - 1] || String(p);
  }
  function escapeHtml(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function formatSize(n) {
    if (n === null || n === undefined || n === "") return "";
    if (n < 1024) return n + " B";
    if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
    return (n / 1048576).toFixed(1) + " MB";
  }
  function scheme(u) {
    var m = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(u);
    return m ? m[1].toLowerCase() : null;
  }
  function safeUrl(u) {
    var s = scheme(u);
    if (s && s !== "http" && s !== "https" && s !== "mailto") return "#";
    return u;
  }
  function safeImgUrl(u) {
    var s = scheme(u);
    if (s && s !== "http" && s !== "https" && s !== "data") return "#";
    if (s === "data" && !/^data:image\//i.test(u)) return "#";
    return u;
  }

  /* ---------- 代码高亮 ---------- */
  var LANG_MAP = {
    ".js": "javascript", ".mjs": "javascript", ".cjs": "javascript", ".jsx": "javascript",
    ".ts": "javascript", ".tsx": "javascript", ".mts": "javascript",
    ".json": "json", ".jsonc": "json",
    ".py": "python", ".pyw": "python",
    ".html": "html", ".htm": "html", ".xml": "html", ".svg": "html",
    ".css": "css", ".scss": "css", ".less": "css",
    ".sh": "shell", ".bash": "shell", ".zsh": "shell", ".ps1": "shell",
    ".yaml": "yaml", ".yml": "yaml",
    ".c": "c", ".h": "c", ".cpp": "c", ".cc": "c", ".cxx": "c", ".hpp": "c",
    ".java": "c", ".go": "c", ".rs": "c", ".kt": "c", ".swift": "c", ".cs": "c",
    ".sql": "sql"
  };

  var TOKEN_RULES = {
    javascript: [
      { type: "comment", pattern: "/\\*[\\s\\S]*?\\*/|//[^\\n]*" },
      { type: "string", pattern: "`(?:\\\\.|[^`\\\\])*`|\"(?:\\\\.|[^\"\\\\])*\"|'(?:\\\\.|[^'\\\\])*'" },
      { type: "keyword", pattern: "\\b(?:const|let|var|function|return|if|else|for|while|do|class|extends|new|import|export|from|default|async|await|yield|typeof|instanceof|in|of|try|catch|finally|throw|this|super|switch|case|break|continue|delete|void|static|get|set|interface|type|enum|implements|private|public|readonly|abstract|as|satisfies|keyof|infer|never|unknown|any|true|false|null|undefined)\\b" },
      { type: "number", pattern: "\\b0[xX][0-9a-fA-F]+\\b|\\b\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?\\b" },
      { type: "func", pattern: "\\b[A-Za-z_$][\\w$]*(?=\\s*\\()" }
    ],
    json: [
      { type: "string", pattern: "\"(?:\\\\.|[^\"\\\\])*\"" },
      { type: "number", pattern: "-?\\b\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?\\b" },
      { type: "keyword", pattern: "\\b(?:true|false|null)\\b" }
    ],
    python: [
      { type: "comment", pattern: "#[^\\n]*" },
      { type: "string", pattern: "\"\"\"[\\s\\S]*?\"\"\"|'''[\\s\\S]*?'''|\"(?:\\\\.|[^\"\\\\])*\"|'(?:\\\\.|[^'\\\\])*'" },
      { type: "keyword", pattern: "\\b(?:def|return|if|elif|else|for|while|import|from|as|class|try|except|finally|with|pass|break|continue|lambda|None|True|False|and|or|not|in|is|yield|async|await|raise|global|nonlocal|del|assert|self)\\b" },
      { type: "number", pattern: "\\b\\d+(?:\\.\\d+)?\\b" },
      { type: "decorator", pattern: "@[A-Za-z_][\\w]*" }
    ],
    html: [
      { type: "comment", pattern: "<!--[\\s\\S]*?-->" },
      { type: "string", pattern: "\"(?:\\\\.|[^\"\\\\])*\"|'(?:\\\\.|[^'\\\\])*'" },
      { type: "tag", pattern: "</?[A-Za-z][\\w-]*(?:\\s+[A-Za-z-]+(?:=(?:\"[^\"]*\"|'[^']*'|[^\\s>]+))?)*\\s*/?>" }
    ],
    css: [
      { type: "comment", pattern: "/\\*[\\s\\S]*?\\*/" },
      { type: "string", pattern: "\"(?:\\\\.|[^\"\\\\])*\"|'(?:\\\\.|[^'\\\\])*'" },
      { type: "keyword", pattern: "\\b(?:@media|@import|@keyframes|@font-face|@supports|@charset)\\b" },
      { type: "number", pattern: "#[0-9a-fA-F]{3,8}\\b|\\b\\d+(?:\\.\\d+)?(?:px|em|rem|%|vh|vw|s|ms)?\\b" },
      { type: "func", pattern: "[a-zA-Z-]+(?=\\s*:)" }
    ],
    shell: [
      { type: "comment", pattern: "#[^\\n]*" },
      { type: "string", pattern: "\"(?:\\\\.|[^\"\\\\])*\"|'(?:\\\\.|[^'\\\\])*'" },
      { type: "keyword", pattern: "\\b(?:if|then|else|elif|fi|for|while|do|done|case|esac|function|in|echo|export|local|return|exit|source|cd|sudo|set|unset|read|shift|printf)\\b" },
      { type: "var", pattern: "\\$\\{[^}]*\\}|\\$[A-Za-z_][\\w]*" }
    ],
    yaml: [
      { type: "comment", pattern: "#[^\\n]*" },
      { type: "string", pattern: "\"(?:\\\\.|[^\"\\\\])*\"|'(?:\\\\.|[^'\\\\])*'" },
      { type: "keyword", pattern: "\\b(?:true|false|null|yes|no|on|off)\\b" },
      { type: "number", pattern: "\\b\\d+(?:\\.\\d+)?\\b" },
      { type: "key", pattern: "^\\s*[-]?\\s*[A-Za-z_][\\w-]*(?=\\s*:)" }
    ],
    c: [
      { type: "comment", pattern: "/\\*[\\s\\S]*?\\*/|//[^\\n]*" },
      { type: "string", pattern: "\"(?:\\\\.|[^\"\\\\])*\"|'(?:\\\\.|[^'\\\\])*'" },
      { type: "keyword", pattern: "\\b(?:if|else|for|while|do|return|break|continue|switch|case|default|struct|class|enum|union|typedef|sizeof|static|const|volatile|extern|void|int|char|float|double|long|short|unsigned|signed|bool|true|false|null|new|delete|public|private|protected|namespace|using|template|typename|interface|implements|extends|func|var|package|import|pub|fn|let|mut|impl|trait|match|loop|self|nil|None|Some|Ok|Err)\\b" },
      { type: "number", pattern: "\\b0[xX][0-9a-fA-F]+\\b|\\b\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?[fF]?\\b" },
      { type: "func", pattern: "\\b[A-Za-z_][\\w]*(?=\\s*\\()" }
    ],
    sql: [
      { type: "comment", pattern: "--[^\\n]*|/\\*[\\s\\S]*?\\*/" },
      { type: "string", pattern: "'(?:''|[^'])*'|\"(?:\\\\.|[^\"\\\\])*\"" },
      { type: "keyword", pattern: "\\b(?:select|from|where|insert|into|values|update|set|delete|create|table|drop|alter|join|left|right|inner|outer|on|group|by|order|having|limit|offset|and|or|not|null|as|distinct|union|all|count|sum|avg|min|max|primary|key|foreign|references|index|view|trigger|begin|commit|rollback)\\b" },
      { type: "number", pattern: "\\b\\d+(?:\\.\\d+)?\\b" }
    ]
  };

  function detectLanguage(p) {
    var m = /\.[A-Za-z0-9]+$/.exec(String(p || ""));
    return m ? (LANG_MAP[m[0].toLowerCase()] || null) : null;
  }

  function highlightCode(code, lang) {
    var rules = TOKEN_RULES[lang];
    if (!rules || !rules.length) return escapeHtml(code);
    var parts = rules.map(function (r) { return "(?<" + r.type + ">" + r.pattern + ")"; });
    var re = new RegExp(parts.join("|"), "g");
    var out = "";
    var last = 0;
    var m;
    while ((m = re.exec(code)) !== null) {
      if (m.index > last) out += escapeHtml(code.slice(last, m.index));
      var type = null;
      var g = m.groups;
      for (var k in g) { if (g[k] !== undefined) { type = k; break; } }
      out += '<span class="tok-' + (type || "plain") + '">' + escapeHtml(m[0]) + '</span>';
      last = m.index + m[0].length;
      if (m[0].length === 0) re.lastIndex += 1;
    }
    out += escapeHtml(code.slice(last));
    return out;
  }

  /* ---------- Markdown 渲染 ---------- */
  function inline(raw) {
    var s = escapeHtml(raw);
    var codes = [];
    s = s.replace(/`([^`]+)`/g, function (_, c) { codes.push(c); return "\u0001" + (codes.length - 1) + "\u0001"; });
    s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, function (_, alt, u) {
      return '<img alt="' + alt + '" src="' + safeImgUrl(u) + '">';
    });
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function (_, t, u) {
      return '<a href="' + safeUrl(u) + '" target="_blank" rel="noopener">' + t + '</a>';
    });
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/__([^_]+)__/g, "<strong>$1</strong>");
    s = s.replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, "$1<em>$2</em>");
    s = s.replace(/~~([^~]+)~~/g, "<del>$1</del>");
    s = s.replace(/\u0001(\d+)\u0001/g, function (_, i) { return "<code>" + codes[+i] + "</code>"; });
    return s;
  }

  function fenceLang(tag) {
    var map = { js: "javascript", javascript: "javascript", ts: "javascript", typescript: "javascript", json: "json", py: "python", python: "python", html: "html", xml: "html", css: "css", sh: "shell", bash: "shell", shell: "shell", yaml: "yaml", yml: "yaml", c: "c", cpp: "c", java: "c", go: "c", rs: "c", sql: "sql" };
    return map[(tag || "").toLowerCase()] || null;
  }

  function splitRow(line) {
    var s = String(line || "").trim();
    if (s.charAt(0) === "|") s = s.slice(1);
    if (s.charAt(s.length - 1) === "|") s = s.slice(0, -1);
    return s.split("|");
  }

  function isTableSeparator(line) {
    if (/\|/.test(line) === false) return false;
    var cells = splitRow(line);
    if (cells.length < 1) return false;
    for (var i = 0; i < cells.length; i++) {
      if (!/^\s*:?-+:?\s*$/.test(cells[i])) return false;
    }
    return true;
  }

  function mdToHtml(text) {
    var lines = (text || "").replace(/\r\n/g, "\n").split("\n");
    var out = [];
    var i = 0;
    while (i < lines.length) {
      var line = lines[i];
      var fence = /^```(\w*)\s*$/.exec(line);
      if (fence) {
        var lang = fenceLang(fence[1]);
        var buf = [];
        i++;
        while (i < lines.length && !/^```\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
        i++;
        var code = buf.join("\n");
        out.push('<pre><code>' + highlightCode(code, lang) + '</code></pre>');
        continue;
      }
      var hd = /^(#{1,6})\s+(.*)$/.exec(line);
      if (hd) {
        var lvl = hd[1].length;
        out.push('<h' + lvl + '>' + inline(hd[2]) + '</h' + lvl + '>');
        i++;
        continue;
      }
      if (/\|/.test(line) && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
        var headerCells = splitRow(line);
        var aligns = splitRow(lines[i + 1]).map(function (c) {
          var t = c.trim();
          if (/^:.*:$/.test(t)) return "center";
          if (/^:/.test(t)) return "left";
          if (/:$/.test(t)) return "right";
          return "";
        });
        var thead = "<tr>" + headerCells.map(function (c, idx) {
          return "<th" + (aligns[idx] ? ' style="text-align:' + aligns[idx] + '"' : "") + ">" + inline(c.trim()) + "</th>";
        }).join("") + "</tr>";
        var trows = [];
        i += 2;
        while (i < lines.length && /\|/.test(lines[i]) && !/^\s*$/.test(lines[i])) {
          var cells = splitRow(lines[i]);
          trows.push("<tr>" + cells.map(function (c, idx) {
            return "<td" + (aligns[idx] ? ' style="text-align:' + aligns[idx] + '"' : "") + ">" + inline(c.trim()) + "</td>";
          }).join("") + "</tr>");
          i++;
        }
        out.push('<table class="dfe-md-table"><thead>' + thead + '</thead><tbody>' + trows.join("") + '</tbody></table>');
        continue;
      }
      if (/^\s*([-*_])\s*(?:\1\s*){2,}$/.test(line)) { out.push("<hr/>"); i++; continue; }
      if (/^\s*>\s?/.test(line)) {
        var q = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) { q.push(lines[i].replace(/^\s*>\s?/, "")); i++; }
        out.push('<blockquote>' + mdToHtml(q.join("\n")) + '</blockquote>');
        continue;
      }
      if (/^\s*[-*+]\s+/.test(line)) {
        var items = [];
        while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*[-*+]\s+/, "")); i++; }
        out.push('<ul>' + items.map(function (it) { return '<li>' + inline(it) + '</li>'; }).join("") + '</ul>');
        continue;
      }
      if (/^\s*\d+[.)]\s+/.test(line)) {
        var oitems = [];
        while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) { oitems.push(lines[i].replace(/^\s*\d+[.)]\s+/, "")); i++; }
        out.push('<ol>' + oitems.map(function (it) { return '<li>' + inline(it) + '</li>'; }).join("") + '</ol>');
        continue;
      }
      if (/^\s*$/.test(line)) { i++; continue; }
      var para = [];
      while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^(#{1,6}\s|```|>|\s*[-*+]\s|\s*\d+[.)]\s)/.test(lines[i]) && !/^\s*([-*_])\s*(?:\1\s*){2,}$/.test(lines[i])) {
        para.push(lines[i]); i++;
      }
      out.push('<p>' + inline(para.join(" ")) + '</p>');
    }
    return out.join("");
  }

  /* ---------- 渲染 ---------- */
  function currentDrive() {
    var m = /^([A-Za-z]:)/.exec(cur || "");
    return m ? m[1].toUpperCase() : "";
  }

  function renderMode() {
    collapsedStrip.style.display = state.collapsed ? "flex" : "none";
    expanded.style.display = state.collapsed ? "none" : "flex";
    resizer.style.display = state.collapsed ? "none" : "block";
    treeTab.classList.toggle("active", activeTab === "tree");
    previewTab.classList.toggle("active", activeTab === "preview");
    treePanel.style.display = activeTab === "tree" ? "flex" : "none";
    viewPanel.style.display = activeTab === "preview" ? "block" : "none";
  }

  function renderDrives() {
    var curDrive = currentDrive();
    driveSel.textContent = "";
    for (var i = 0; i < drives.length; i++) {
      var opt = document.createElement("option");
      opt.value = drives[i].path;
      opt.textContent = drives[i].name;
      if (drives[i].name === curDrive) opt.selected = true;
      driveSel.appendChild(opt);
    }
  }

  async function loadDrives() {
    try {
      drives = await fs.drives();
      renderDrives();
    } catch (e) { /* 忽略 */ }
  }

  function renderTree() {
    tree.textContent = "";
    var f = filterInput.value.trim().toLowerCase();
    if (curParent && curParent !== cur) {
      var up = h("div", "dfe-item dir", "..");
      up.onclick = function () { loadDir({ dir: curParent }); };
      tree.appendChild(up);
    }
    var list = f ? entries.filter(function (e) { return e.name.toLowerCase().indexOf(f) >= 0; }) : entries;
    if (list.length === 0) {
      tree.appendChild(h("div", "dfe-empty", f ? "无匹配项" : "（空目录）"));
      return;
    }
    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      var isDir = e.type === "directory";
      var icon = isDir ? "📁 " : (isImage(e.name) ? "🖼 " : "📄 ");
      var item = h("div", "dfe-item" + (isDir ? " dir" : ""), icon + e.name);
      item.title = e.name;
      (function (entry) {
        item.onclick = function () {
          if (entry.type === "directory") loadDir({ dir: cur, name: entry.name });
          else openFile({ dir: cur, name: entry.name });
        };
      })(e);
      tree.appendChild(item);
    }
  }

  function renderCodeLines(content, lang) {
    var lines = String(content || "").split("\n");
    if (lines.length && lines[lines.length - 1] === "") lines.pop();
    var box = h("div", "dfe-code");
    for (var i = 0; i < lines.length; i++) {
      var row = h("div", "dfe-code-line");
      row.appendChild(h("span", "dfe-code-num", String(i + 1)));
      var txt = h("span", "dfe-code-text");
      txt.innerHTML = highlightCode(lines[i], lang);
      row.appendChild(txt);
      box.appendChild(row);
    }
    return box;
  }

  function renderView() {
    viewPanel.textContent = "";
    if (!selected) { viewPanel.appendChild(h("div", "dfe-empty", "点击文件查看代码 / 文档 / 图片")); return; }
    if (selected.kind === "loading") { viewPanel.appendChild(h("div", "dfe-empty", "读取中…")); return; }
    if (selected.kind === "error") { viewPanel.appendChild(h("div", "dfe-empty", selected.error || "读取失败")); return; }
    if (selected.kind === "binary") { viewPanel.appendChild(h("div", "dfe-empty", "二进制文件，暂不支持预览")); return; }
    if (selected.kind === "directory") { viewPanel.appendChild(h("div", "dfe-empty", "这是一个目录")); return; }

    if (selected.kind === "image") {
      if (selected.tooLarge) {
        viewPanel.appendChild(h("div", "dfe-empty", "图片过大（>8MB），暂不支持预览"));
        return;
      }
      var meta = h("div", "dfe-meta");
      meta.appendChild(document.createTextNode([basename(selected.path), formatSize(selected.size)].filter(Boolean).join(" · ")));
      viewPanel.appendChild(meta);
      var img = document.createElement("img");
      img.className = "dfe-image";
      img.alt = basename(selected.path);
      img.src = selected.dataUrl;
      viewPanel.appendChild(img);
      return;
    }

    if (selected.kind === "file") {
      var isMd = isMarkdown(selected.path);
      var lang = detectLanguage(selected.path);
      var lineCount = (selected.content || "").split("\n").length;
      var metaText = [basename(selected.path), formatSize(selected.size), lineCount + " 行"].filter(Boolean).join(" · ");
      var meta = h("div", "dfe-meta");
      meta.appendChild(document.createTextNode(metaText));
      if (isMd) {
        meta.appendChild(h("span", "dfe-spacer"));
        var toggle = h("button", "dfe-btn", mdMode === "preview" ? "源码" : "预览");
        toggle.onclick = function () { mdMode = mdMode === "preview" ? "source" : "preview"; renderView(); };
        meta.appendChild(toggle);
      }
      viewPanel.appendChild(meta);
      if (selected.truncated) viewPanel.appendChild(h("div", "dfe-note", "文件较大，已截断显示"));

      if (isMd && mdMode === "preview") {
        var md = h("div", "dfe-md");
        md.innerHTML = mdToHtml(selected.content || "");
        viewPanel.appendChild(md);
      } else if (lang) {
        viewPanel.appendChild(renderCodeLines(selected.content, lang));
      } else {
        viewPanel.appendChild(h("pre", "", selected.content || ""));
      }
      return;
    }
  }

  async function loadDir(payload) {
    try {
      var res = await fs.list(payload || {});
      cur = res.path;
      curParent = res.parent;
      entries = res.entries || [];
      crumb.textContent = res.path;
      title.textContent = "📁 " + basename(res.path);
      renderDrives();
      renderTree();
    } catch (e) {
      crumb.textContent = "加载失败";
      tree.textContent = "";
      tree.appendChild(h("div", "dfe-empty", "读取目录失败: " + String((e && e.message) || e)));
    }
  }

  async function openFile(payload) {
    activeTab = "preview";
    renderMode();
    selected = { kind: "loading" };
    renderView();
    try {
      selected = await fs.read(payload);
    } catch (e) {
      selected = { kind: "error", error: "读取失败: " + String((e && e.message) || e) };
    }
    renderView();
  }

  function isMarkdown(p) { return /\.(md|markdown|mdown)$/i.test(String(p || "")); }
  function isImage(p) { return /\.(png|jpe?g|gif|webp|bmp|ico|svg)$/i.test(String(p || "")); }

  collapseBtn.onclick = function () { if (ui) ui.toggle(); };
  expandBtn.onclick = function () { if (ui) ui.toggle(); };
  refreshBtn.onclick = function () { loadDir({ dir: cur }); };
  filterInput.oninput = function () { renderTree(); };
  driveSel.onchange = function () { loadDir({ dir: driveSel.value }); };
  treeTab.onclick = function () { activeTab = "tree"; renderMode(); };
  previewTab.onclick = function () { activeTab = "preview"; renderMode(); };

  if (ui && ui.onState) {
    ui.onState(function (s) {
      state = s || { collapsed: false, width: 360 };
      renderMode();
    });
  }

  if (ui && ui.onWorkspaceRoot) {
    ui.onWorkspaceRoot(function (root) {
      if (root && typeof root === "string" && root !== cur) {
        loadDir({ dir: root });
      }
    });
  }

  resizer.addEventListener("pointerdown", function (e) {
    e.preventDefault();
    var startScreenX = e.screenX;
    var startWidth = state.width;
    resizer.setPointerCapture(e.pointerId);
    var move = function (ev) {
      var w = startWidth - (ev.screenX - startScreenX);
      if (ui && ui.setWidth) ui.setWidth(Math.round(w));
    };
    var up = function () {
      resizer.removeEventListener("pointermove", move);
      resizer.removeEventListener("pointerup", up);
      resizer.removeEventListener("pointercancel", up);
    };
    resizer.addEventListener("pointermove", move);
    resizer.addEventListener("pointerup", up);
    resizer.addEventListener("pointercancel", up);
  });

  renderMode();
  loadDrives();
  loadDir(null);
})();
