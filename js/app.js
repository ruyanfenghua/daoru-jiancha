/* 门店数据导入校验
 * 客户给的表在导进系统前，先做三件事：认列、查错、洗干净。
 * 全部在浏览器里算，不上传文件。
 */
(function () {
  'use strict';

  var $ = function (s, r) { return (r || document).querySelector(s); };

  /* ---------- 目标字段（系统能吃的格式） ---------- */
  var SCHEMA = [
    { key: 'store',   label: '门店名称', req: true,  type: 'text',   max: 40,  clean: 'name', kw: ['门店', '店名', '店铺', '名称', 'store', 'shop', 'name'] },
    { key: 'contact', label: '联系人',   req: true,  type: 'text',   max: 20,  kw: ['联系人', '姓名', '负责人', '店长', 'contact'] },
    { key: 'phone',   label: '手机号',   req: true,  type: 'phone',            kw: ['手机', '电话', '联系方式', 'phone', 'mobile', 'tel'] },
    { key: 'addr',    label: '地址',     req: false, type: 'text',   max: 80,  clean: 'nospace', kw: ['地址', 'location', 'address', 'addr'] },
    { key: 'date',    label: '开业日期', req: false, type: 'date',             kw: ['日期', '开业', '时间', 'date', 'time'] },
    { key: 'area',    label: '营业面积', req: false, type: 'number',           kw: ['面积', '平方', '平米', 'area', 'size'] },
    { key: 'note',    label: '备注',     req: false, type: 'text',   max: 100, kw: ['备注', '说明', 'note', 'remark', 'comment'] }
  ];

  var state = {
    header: [],
    rows: [],
    mapping: {},     // 列索引 -> schema key
    cells: {},       // "r-c" -> 'bad' | 'warn'
    issues: [],
    view: 'raw',
    lastClean: null
  };

  /* ============================================================
   * CSV 解析：要处理引号内的逗号和换行，不能简单 split
   * ========================================================== */
  function parseCSV(text) {
    var rows = [], row = [], cell = '', q = false;
    text = text.replace(/^\uFEFF/, '');
    for (var i = 0; i < text.length; i++) {
      var c = text[i];
      if (q) {
        if (c === '"') {
          if (text[i + 1] === '"') { cell += '"'; i++; }
          else q = false;
        } else cell += c;
      } else {
        if (c === '"') q = true;
        else if (c === ',') { row.push(cell); cell = ''; }
        else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
        else if (c !== '\r') cell += c;
      }
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows.filter(function (r) { return r.some(function (x) { return String(x).trim() !== ''; }); });
  }

  function toCSV(rows) {
    return rows.map(function (r) {
      return r.map(function (c) {
        c = c === null || c === undefined ? '' : String(c);
        return /[",\n]/.test(c) ? '"' + c.replace(/"/g, '""') + '"' : c;
      }).join(',');
    }).join('\n');
  }

  /* ============================================================
   * 类型判断与清洗
   * ========================================================== */
  function digits(s) { return String(s || '').replace(/\D/g, ''); }

  function normPhone(raw) {
    var d = digits(raw);
    if (d.length === 13 && d.slice(0, 2) === '86') d = d.slice(2);
    if (d.length === 11 && d[0] === '1') return d;
    return null;
  }

  function isLandline(raw) {
    var d = digits(raw);
    return d.length >= 10 && d.length <= 12 && d[0] === '0';
  }

  // 把 2024/3/12、2024-03-12、2024.3.12、24年4月、2024年5月20日 都认出来
  function normDate(raw) {
    var s = String(raw || '').trim();
    if (!s) return null;
    // 2024/3/12、2024-03-12、2023.11.05、24年4月、2024年5月20日 都要认
    var t = s.replace(/年/g, '-').replace(/月/g, '-').replace(/日/g, '')
             .replace(/[.\/]/g, '-').replace(/-+$/g, '');
    var m = t.match(/^(\d{2,4})-(\d{1,2})(?:-(\d{1,2}))?$/);
    if (!m) return null;
    var y = +m[1];
    if (y < 100) y += 2000;
    var mo = +m[2], d = m[3] ? +m[3] : 1;
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    return y + '-' + String(mo).padStart(2, '0') + '-' + String(d).padStart(2, '0');
  }

  function normNumber(raw) {
    var s = String(raw || '').replace(/[㎡平方米\s]/g, '');
    if (!s) return null;
    var n = parseFloat(s);
    return isNaN(n) ? null : n;
  }

  // 门店名归一：去掉分隔符号和空格，用于查重
  function normName(raw) {
    return String(raw || '')
      .replace(/[·・\.\-—_（）()【】\[\]「」\s]/g, '')
      .toLowerCase();
  }

  function width(s) { return Array.from(String(s || '')).length; }

  /* ============================================================
   * 自动认列
   * ========================================================== */
  function inferType(col) {
    var vals = state.rows.map(function (r) { return r[col]; }).filter(function (v) { return String(v || '').trim() !== ''; });
    if (!vals.length) return '空列';
    var phone = 0, date = 0, num = 0;
    vals.forEach(function (v) {
      if (normPhone(v)) phone++;
      else if (isLandline(v)) phone++;
      if (normDate(v)) date++;
      if (normNumber(v) !== null && !isNaN(normNumber(v))) num++;
    });
    var n = vals.length;
    if (phone / n > 0.6) return '手机';
    if (date / n > 0.6) return '日期';
    if (num / n > 0.8) return '数字';
    return '文本';
  }

  function autoMap() {
    var used = {};
    var mapping = {};
    // 先按列名关键词匹配，同名词优先
    state.header.forEach(function (name, ci) {
      var low = String(name).toLowerCase();
      var best = null, bestScore = 0;
      SCHEMA.forEach(function (f) {
        if (used[f.key]) return;
        var score = 0;
        f.kw.forEach(function (k) {
          if (low.indexOf(k) !== -1) score = Math.max(score, k.length);
        });
        // 列名就是字段名，给最高分
        if (low === f.label.toLowerCase() || low === f.key) score = 99;
        if (score > bestScore) { bestScore = score; best = f.key; }
      });
      if (best && bestScore >= 2) { mapping[ci] = best; used[best] = true; }
    });
    // 剩下的按内容类型补
    state.header.forEach(function (name, ci) {
      if (mapping[ci]) return;
      var t = inferType(ci);
      var cand = { '手机': 'phone', '日期': 'date', '数字': 'area' }[t];
      if (cand && !used[cand]) { mapping[ci] = cand; used[cand] = true; }
    });
    return mapping;
  }

  /* ============================================================
   * 检查
   * ========================================================== */
  function inspect() {
    state.cells = {};
    var issues = [];
    var byKey = {};
    Object.keys(state.mapping).forEach(function (ci) {
      byKey[state.mapping[ci]] = +ci;
    });

    // 1. 必填字段有没有缺列
    SCHEMA.forEach(function (f) {
      if (f.req && byKey[f.key] === undefined) {
        issues.push({ level: 'bad', title: '缺少必填字段「' + f.label + '」', desc: '目标系统要求这一列必须有，需要在源表里补上或指定对应列。', focus: null });
      }
    });

    // 2. 逐格检查
    var seen = {};
    var storeSeen = {};
    var storeDup = 0;
    var phoneSeen = {};   // 手机号 → 首次出现的门店名
    var phoneDup = 0;
    var phoneCross = {};  // 因跨店重复而标黄的格子，单独计数
    state.rows.forEach(function (row, ri) {
      SCHEMA.forEach(function (f) {
        var ci = byKey[f.key];
        if (ci === undefined) return;
        var raw = row[ci];
        var v = String(raw === undefined || raw === null ? '' : raw).trim();
        var key = ri + '-' + ci;

        if (!v) {
          state.cells[key] = 'empty';
          if (f.req) { state.cells[key] = 'bad'; }
          return;
        }

        if (f.type === 'phone') {
          if (isLandline(v)) {
            state.cells[key] = 'warn';
          } else {
            var np = normPhone(v);
            if (!np) {
              state.cells[key] = 'bad';
            } else {
              if (digits(v).length === 13) state.cells[key] = 'warn';
              // 同一个号挂在不同门店上：可能是分店共用，也可能录错
              var storeName = normName(String(row[byKey.store] === undefined ? '' : row[byKey.store]));
              if (storeName) {
                if (phoneSeen[np] !== undefined && phoneSeen[np] !== storeName) {
                  if (state.cells[key] !== 'bad') state.cells[key] = 'warn';
                  phoneCross[key] = 1;
                  phoneDup++;
                } else if (phoneSeen[np] === undefined) {
                  phoneSeen[np] = storeName;
                }
              }
            }
          }
        }

        if (f.type === 'date' && !normDate(v)) state.cells[key] = 'bad';
        if (f.type === 'number' && normNumber(v) === null) state.cells[key] = 'bad';
        if (f.type === 'text' && f.max && width(v) > f.max) state.cells[key] = 'warn';

        if (f.key === 'store') {
          var nn = normName(v);
          if (nn) {
            if (seen[nn] !== undefined) {
              state.cells[key] = 'bad';
              state.cells[seen[nn] + '-' + ci] = 'bad';
              if (!storeSeen[nn]) { storeSeen[nn] = 1; storeDup++; }
            } else seen[nn] = ri;
          }
        }
      });
    });

    // 3. 汇总成条目：按字段合并，等级取该字段最严重的一档。
    //    同一列既有硬伤又有建议时，拆成两条只会让清单变长、不增加信息。
    var byField = {};
    Object.keys(state.cells).forEach(function (k) {
      var ci = +k.split('-')[1];
      var f = SCHEMA.find(function (x) { return x.key === state.mapping[ci]; });
      if (!f) return;
      var lv = state.cells[k];
      // 跨店重复在下面单独出一条，这里不重复计数
      if (phoneCross[k] && lv === 'warn') return;
      if (!byField[f.key]) byField[f.key] = { f: f, ci: ci, bad: 0, warn: 0 };
      // 非必填列的空值只在表格标灰，不进清单——那不是要处理的问题
      if (lv === 'empty' && !f.req) return;
      byField[f.key][lv === 'empty' ? 'bad' : lv]++;
    });

    var ORDER = { bad: 0, warn: 1 };
    Object.keys(byField).sort(function (a, b) {
      var A = byField[a], B = byField[b];
      var la = A.bad ? 'bad' : 'warn', lb = B.bad ? 'bad' : 'warn';
      return (ORDER[la] - ORDER[lb]) || ((B.bad + B.warn) - (A.bad + A.warn));
    }).forEach(function (key) {
      var t = byField[key];
      // 只有空值的非必填列会被跳过计数，别在清单上留下一条 0 处的空条目
      if (!t.bad && !t.warn) return;
      var lv = t.bad ? 'bad' : 'warn';
      var n = t.bad + t.warn;
      // 门店重复按"家"算，不是按格子算
      var title, desc;
      if (key === 'store' && storeDup) {
        title = '门店重复 ' + storeDup + ' 家';
        desc = '归一化后是同一家店';
      } else {
        title = t.f.label + ' ' + n + ' 处';
        desc = {
          phone: t.bad ? '不是 11 位手机号' : '座机或带国际区号',
          date: '格式认不出',
          number: '含非数字',
          store: '店名为空',
          contact: '必填，空',
          addr: '地址为空',
          area: '含非数字',
          note: '超过 ' + (t.f.max || 0) + ' 字'
        }[key] || '';
      }
      issues.push({ level: lv, title: title, desc: desc, focus: t.ci });
    });

    if (phoneDup) {
      var pci = byKey.phone;
      issues.push({
        level: 'warn',
        title: '手机号跨店重复 ' + phoneDup + ' 处',
        desc: '同一个号挂在不同门店',
        focus: pci === undefined ? null : pci
      });
    }

    // 4. 重复行
    var dup = 0, dupRows = [];
    var rowKeys = {};
    state.rows.forEach(function (row, ri) {
      var k = row.map(function (x) { return String(x || '').trim(); }).join('\u0001');
      if (rowKeys[k] !== undefined) { dup++; dupRows.push(ri); }
      else rowKeys[k] = ri;
    });
    if (dup) {
      issues.push({ level: 'warn', title: '整行重复 ' + dup + ' 条', desc: '所有列都一样的行，导出时会自动去掉。', focus: null });
    }

    state.issues = issues;
    return issues;
  }

  function scoreOf(issues) {
    if (!issues.length) return 100;
    var pen = 0;
    issues.forEach(function (i) {
      if (i.level === 'bad') pen += 9;
      else pen += 3;
    });
    return Math.max(12, 100 - pen);
  }

  /* ============================================================
   * 渲染
   * ========================================================== */
  function renderTable() {
  if (state.view === 'clean' && state.rows.length) { renderClean(); return; }

  var t = $('#grid');
  var byKey = {};
  Object.keys(state.mapping).forEach(function (ci) { byKey[state.mapping[ci]] = +ci; });

  var head = '<thead><tr><th class="rownum"><div class="th-in"><span class="th-name">#</span></div></th>';
  state.header.forEach(function (name, ci) {
    var f = SCHEMA.find(function (x) { return x.key === state.mapping[ci]; });
    // 副标题只写类型。映射到哪个字段右侧面板已经列全了，
    // 表头再写一遍会让两行字抢同一件事，且大多数时候只是名字差个后缀。
    var sub = f ? inferType(ci) : '未对应';
    head += '<th class="' + (f ? 'mapped' : 'none') + (f && f.type === 'text' ? ' wide' : '') + '">'
      + '<div class="th-in"><span class="th-name">' + esc(name) + '</span>'
      + '<span class="th-type">' + sub + '</span></div></th>';
  });
  head += '</tr></thead>';

  var body = '<tbody>';
  state.rows.forEach(function (row, ri) {
    body += '<tr><td class="rownum"><div class="td-in">' + (ri + 1) + '</div></td>';
    state.header.forEach(function (_, ci) {
      var v = row[ci] === undefined ? '' : row[ci];
      var lv = state.cells[ri + '-' + ci];
      var cls = lv === 'bad' ? 'bad' : lv === 'warn' ? 'warn' : (lv === 'empty' ? 'empty-cell' : '');
      body += '<td class="' + cls + '"><div class="td-in" title="' + esc(v) + '">' + esc(v) + '</div></td>';
    });
    body += '</tr>';
  });
  body += '</tbody>';

  t.innerHTML = head + body;
}

/* 清洗后视图：列是按目标系统重排的，改过的格子标绿 */
function renderClean() {
  var t = $('#grid');
  var res = cleanRows();
  state.lastClean = res;

  var TYPE_LABEL = { text: '文本', phone: '手机', date: '日期', number: '数字' };
  var head = '<thead><tr><th class="rownum"><div class="th-in"><span class="th-name">#</span></div></th>';
  SCHEMA.forEach(function (f) {
    head += '<th class="' + (f.type === 'text' ? 'wide' : '') + '">'
      + '<div class="th-in"><span class="th-name">' + f.label
      + (f.req ? '<em class="req">*</em>' : '') + '</span>'
      + '<span class="th-type">' + TYPE_LABEL[f.type] + '</span></div></th>';
  });
  head += '</tr></thead>';

  var body = '<tbody>';
  res.rows.slice(1).forEach(function (row, ri) {
    body += '<tr><td class="rownum"><div class="td-in">' + (ri + 1) + '</div></td>';
    row.forEach(function (v, ci) {
      var changed = res.meta[ri + 1] && res.meta[ri + 1][ci];
      body += '<td class="' + (changed ? 'fixed' : '') + '"><div class="td-in" title="' + esc(v) + '">' + esc(v) + '</div></td>';
    });
    body += '</tr>';
  });
  body += '</tbody>';

  t.innerHTML = head + body;

  var fixedN = 0;
  res.meta.slice(1).forEach(function (r) { r.forEach(function (x) { if (x) fixedN++; }); });
  var dropTxt = res.dropped
    ? '剔除 ' + res.dropped + '（空 ' + res.reasons.empty + ' · 号错 ' + res.reasons.badphone + ' · 重 ' + res.reasons.dup + '）'
    : '未剔除';
  $('#fileMeta').textContent = (res.rows.length - 1) + ' 行 · 修正 ' + fixedN + ' · ' + dropTxt;
}

function esc(s) {
    return String(s === undefined || s === null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function renderSide() {
    var issues = state.issues;
    var score = scoreOf(issues);

    // 空表时那个破折号在大字号下会被拉成一条白杠，看着像 UI 元素
    $('#scoreVal').textContent = state.rows.length ? score : '';
    $('#scoreVal').style.color = !state.rows.length ? 'var(--ink)'
      : score >= 85 ? 'var(--good)' : score >= 60 ? 'var(--warn)' : 'var(--bad)';
    $('#scoreFill').style.width = (state.rows.length ? score : 0) + '%';
    $('#scoreFill').style.background = score >= 85 ? 'var(--good)' : score >= 60 ? 'var(--warn)' : 'var(--bad)';
    $('#scoreNote').textContent = !state.rows.length
      ? ''
      : score >= 85 ? '可直接导入'
      : score >= 60 ? '建议先处理标红'
      : '问题较多';

    $('#issueCount').textContent = issues.length;

    if (!issues.length) {
      $('#issueList').innerHTML = '<li class="issue-empty">' + (state.rows.length ? '没有发现问题' : '还没有检查') + '</li>';
    } else {
      $('#issueList').innerHTML = issues.map(function (it, i) {
        return '<li class="issue ' + (it.level === 'bad' ? 'open' : 'ok') + '" data-focus="' + (it.focus === null ? '' : it.focus) + '" data-i="' + i + '">'
          + '<span class="issue-dot"></span>'
          + '<span class="issue-body"><span class="issue-t">' + esc(it.title) + '</span>'
          + '<span class="issue-d">' + esc(it.desc) + '</span></span></li>';
      }).join('');
    }

    var mappedCount = Object.keys(state.mapping).length;
    var needCount = SCHEMA.filter(function (f) { return f.req; }).length;
    var mappedReq = SCHEMA.filter(function (f) { return f.req && Object.values(state.mapping).indexOf(f.key) !== -1; }).length;
    $('#mapCount').textContent = mappedCount + ' / ' + SCHEMA.length;

    $('#mapList').innerHTML = state.header.map(function (name, ci) {
      var cur = state.mapping[ci] || '';
      var opts = '<option value="">不导入</option>' + SCHEMA.map(function (f) {
        return '<option value="' + f.key + '"' + (cur === f.key ? ' selected' : '') + '>' + f.label + (f.req ? ' *' : '') + '</option>';
      }).join('');
      return '<li class="map-row"><span class="map-src" title="' + esc(name) + '">' + esc(name) + '</span>'
        + '<span class="map-arrow">→</span>'
        + '<select data-ci="' + ci + '" class="' + (cur ? 'ok' : '') + '">' + opts + '</select></li>';
    }).join('');
  }

  /* ============================================================
   * 清洗与导出
   * ========================================================== */
  function cleanRows() {
  var byKey = {};
  Object.keys(state.mapping).forEach(function (ci) { byKey[state.mapping[ci]] = +ci; });

  var out = [SCHEMA.map(function (f) { return f.label; })];
  var meta = [SCHEMA.map(function () { return false; })];
  var seen = {};
  var dropped = 0;
  var reasons = { empty: 0, badphone: 0, dup: 0 };

  state.rows.forEach(function (row) {
    var rec = [];
    var marks = [];
    var bad = '';   // 这一行为什么不能导

    SCHEMA.forEach(function (f) {
      var ci = byKey[f.key];
      var raw = ci === undefined ? '' : String(row[ci] === undefined ? '' : row[ci]).trim();
      var v = raw;

      if (f.type === 'phone') {
        var p = normPhone(v);
        if (p) v = p;
        else if (v && !bad) bad = 'badphone';
      }
      if (f.type === 'date') { var d = normDate(v); if (d) v = d; }
      if (f.type === 'number') { var n = normNumber(v); if (n !== null) v = String(n); }
      if (f.clean === 'name') v = v.replace(/\s+/g, ' ').replace(/（/g, '(').replace(/）/g, ')');
      if (f.clean === 'nospace') v = v.replace(/\s+/g, '');

      if (f.req && !v && !bad) bad = 'empty';
      rec.push(v);
      marks.push(!!raw && v !== raw);
    });

    if (bad) { dropped++; reasons[bad]++; return; }

    // 去重看的是"必填字段全都一样"，不是固定第几列
    var key = SCHEMA.map(function (f, i) {
      return f.req ? normName(rec[i]) : '';
    }).join('|');
    if (seen[key]) { dropped++; reasons.dup++; return; }
    seen[key] = 1;

    out.push(rec);
    meta.push(marks);
  });

  return { rows: out, meta: meta, dropped: dropped, reasons: reasons };
}

function download(name, text) {
    var blob = new Blob(['\uFEFF' + text], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    // 不在文档里的 a 标签，部分浏览器不会触发下载
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { a.remove(); }, 20000);
  }

  function toast(msg) {
    var el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(el._t);
    el._t = setTimeout(function () { el.classList.remove('show'); }, 2200);
  }

  /* ============================================================
   * 载入
   * ========================================================== */
  function load(rows, meta) {
    state.header = rows[0].map(function (h) { return String(h).trim(); });
    state.rows = rows.slice(1).filter(function (r) { return r.some(function (x) { return String(x).trim() !== ''; }); });
    state.mapping = autoMap();
    state.issues = [];
    state.cells = {};
    state.view = 'raw';
    var vt = document.querySelectorAll('.vt');
    Array.prototype.forEach.call(vt, function (x) { x.classList.toggle('active', x.dataset.view === 'raw'); });

    $('#tableWrap').hidden = false;
    $('#dropzone').hidden = true;
    state.meta = meta;
    $('#fileMeta').textContent = meta;

    inspect();
    renderTable();
    renderSide();

    $('#btnExport').disabled = false;
  }

  /* ---------- 示例数据：一份典型的需要清洗的门店表 ---------- */
  var SAMPLE = [
    ['门店名称', '联系人', '手机', '门店地址', '开业时间', '面积', '备注'],
    ['小满食堂·体育场路店', '陈晓雯', '138 5712 3344', '杭州市拱墅区体育场路 88 号', '2024/3/12', '186㎡', '早高峰排队严重'],
    ['小满食堂 体育场路店', '陈晓雯', '13857123344', '杭州市拱墅区体育场路88号', '2024-03-12', '186', ''],
    ['小满食堂（湖墅店）', '李伟', '1385712334', '杭州拱墅区湖墅南路 12 号', '24年4月', '', ''],
    ['小满食堂·文三路店', '', '13857123399', '西湖区文三路 258 号', '2023.11.05', '152', ''],
    ['小满食堂(滨江店)', '王芳', '+86 138 5712 3388', '滨江区江南大道 588 号', '2024/1/8', '210.5', '新店，开业活动期间客流大'],
    ['小满食堂·城西银泰店', '张强', '0571-88776655', '拱墅区丰潭路 380 号', '2023/9/1', '320', '留的是座机，店长手机待补'],
    ['小满食堂·下沙店', '刘洋', '13857123377', '钱塘区下沙 6 号大街', '2024/05/20', '', ''],
    ['小满食堂·下沙店', '刘洋', '13857123377', '钱塘区下沙6号大街', '2024-05-20', '', '重复导入'],
    ['小满食堂·临平店', '赵敏', '13857123388', '临平区南苑街道 18 号', '2022/6/15', '95', '门店已翻新，面积增加到 130 平方米，需要更新系统里的面积字段；另外收银机型号也换了，从原来的 A 型换成了 B 型，需要重新配置打印机和钱箱；后厨的平板也换了一台，之前装的点餐客户端要重装，账号还是用店长手机号，密码沿用旧的不变，等这批门店统一换完之后再一起改'],
    ['', '孙丽', '13857123300', '余杭区文一西路 969 号', '2024/7/1', '110', '店名待补']
  ];

  /* ============================================================
   * 事件
   * ========================================================== */
  $('#btnSample').addEventListener('click', function () {
    load(SAMPLE.map(function (r) { return r.slice(); }), '11 × 7');
    toast('已载入示例');
  });

  // 中文 Excel 另存的 CSV 默认是 GBK，按 UTF-8 硬读整张表会变成问号。
  // 先按 UTF-8 解，出现替换字符就换 GBK 再解一次。
  function readCSV(f) {
    var fr = new FileReader();
    fr.onload = function () {
      var buf = fr.result;
      var text = new TextDecoder('utf-8').decode(buf);
      if (text.indexOf('�') >= 0) {
        try { text = new TextDecoder('gbk').decode(buf); } catch (err) {}
      }
      var rows = parseCSV(text);
      if (rows.length < 2) { toast('没有数据行'); return; }
      load(rows, f.name + ' · ' + (rows.length - 1) + ' × ' + rows[0].length);
    };
    fr.readAsArrayBuffer(f);
  }

  $('#fileInput').addEventListener('change', function (e) {
    var f = e.target.files[0];
    if (f) readCSV(f);
  });

  var dz = $('#dropzone');
  ['dragenter', 'dragover'].forEach(function (ev) {
    dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.add('over'); });
  });
  ['dragleave', 'drop'].forEach(function (ev) {
    dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.remove('over'); });
  });
  dz.addEventListener('drop', function (e) {
    var f = e.dataTransfer.files[0];
    if (f) readCSV(f);
  });

  $('#mapList').addEventListener('change', function (e) {
    var sel = e.target.closest('select');
    if (!sel) return;
    var ci = sel.dataset.ci;
    if (sel.value) state.mapping[ci] = sel.value;
    else delete state.mapping[ci];
    inspect();
    renderTable();
    renderSide();
  });

  $('#vtGroup').addEventListener('click', function (e) {
    var btn = e.target.closest('.vt');
    if (!btn || !state.rows.length) return;
    state.view = btn.dataset.view;
    Array.prototype.forEach.call(document.querySelectorAll('.vt'), function (x) {
      x.classList.toggle('active', x === btn);
    });
    // 清洗后视图里，右边这堆问题属于源表；不换标题会被读成"洗完还有 4 个问题"
    $('#' + 'issueHead').textContent = state.view === 'clean' ? '源表问题' : '问题';
    renderTable();
    if (state.view === 'raw') {
      $('#fileMeta').textContent = state.meta || '';
    }
  });

  $('#issueList').addEventListener('click', function (e) {
    var li = e.target.closest('.issue');
    if (!li) return;
    var ci = li.dataset.focus;
    if (ci === '') { return; }
    var cell = $('#grid tbody td.bad, #grid tbody td.warn');
    var target = document.querySelector('#grid tbody tr td:nth-child(' + (+ci + 2) + ')');
    if (target) {
      target.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
      target.style.outline = '2px solid var(--accent)';
      setTimeout(function () { target.style.outline = ''; }, 1400);
    }
  });

  function exportClean() {
    var res = cleanRows();
    download('clean_' + new Date().toISOString().slice(0, 10) + '.csv', toCSV(res.rows));
    toast('已导出');
  }

  function exportReport() {
    var res = cleanRows();
    var report = [['问题', '说明', '数量']];
    state.issues.forEach(function (i) {
      report.push([i.title, i.desc, '']);
    });
    report.push(['', '', '']);
    report.push(['导出说明', '原始 ' + state.rows.length + ' 行，清洗后 ' + (res.rows.length - 1) + ' 行', '']);
    if (res.dropped) {
      report.push(['剔除原因', '必填为空 ' + res.reasons.empty + ' 行', res.reasons.empty]);
      report.push(['', '手机号不合法 ' + res.reasons.badphone + ' 行', res.reasons.badphone]);
      report.push(['', '重复记录 ' + res.reasons.dup + ' 行', res.reasons.dup]);
    }
    download('report_' + new Date().toISOString().slice(0, 10) + '.csv', toCSV(report));
    toast('已导出');
  }

  // 导出拆成两个入口：一次点击只下一个文件。
  // 同时触发两次，Chrome 会弹"是否允许下载多个文件"，用户没点就两个都没了。
  $('#btnExport').addEventListener('click', function (e) {
    e.stopPropagation();
    $('#expWrap').classList.toggle('open');
  });

  $('#expMenu').addEventListener('click', function (e) {
    var b = e.target.closest('[data-exp]');
    if (!b) return;
    $('#expWrap').classList.remove('open');
    if (b.dataset.exp === 'clean') exportClean();
    else exportReport();
  });

  document.addEventListener('click', function (e) {
    if (!e.target.closest('#expWrap')) $('#expWrap').classList.remove('open');
  });

  /* 键盘：cmd/ctrl+enter 导出 */
  document.addEventListener('keydown', function (e) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !$('#btnExport').disabled) {
      e.preventDefault();
      exportClean();
    }
  });
})();
