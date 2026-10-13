// Compare against the editor's current text, including unsaved edits.
export function reviewCode({ original, proposed, filename, language }) {
  return new Promise(resolve => {
    const dialog = document.createElement('dialog');
    dialog.className = 'code-review';
    dialog.setAttribute('aria-label', '审核 AI 代码修改');
    dialog.innerHTML = `<div class="review-heading"><div><span class="eyebrow">CODE REVIEW</span><h2>审核代码修改 <span class="review-file"></span></h2></div><button class="review-close" aria-label="关闭代码审核">×</button></div><div class="review-toolbar"><span class="review-summary" role="status">正在计算差异…</span><div class="review-controls"><button class="review-prev" aria-label="上一处修改">↑</button><button class="review-next" aria-label="下一处修改">↓</button><button class="review-layout">并排对比</button></div></div><div class="review-legend"><span>红色 − 当前代码中的删除内容</span><span>绿色 + AI 建议新增内容</span></div><div class="review-editor"></div><div class="review-notice">对比基于编辑区当前内容（含未保存修改）。确认后，所选代码块将作为完整文件写入。</div><div class="dialog-actions"><button class="review-cancel">取消</button><button class="primary review-apply" disabled>确认应用修改</button></div>`;
    dialog.querySelector('.review-file').textContent = filename;
    document.body.append(dialog); dialog.showModal();
    let diff, before, after, update, closed = false, sideBySide = false;
    const finish = approved => {
      if (closed) return;
      closed = true; update?.dispose(); diff?.dispose(); before?.dispose(); after?.dispose();
      dialog.close(); dialog.remove(); resolve(approved);
    };
    dialog.querySelector('.review-cancel').onclick = () => finish(false);
    dialog.querySelector('.review-close').onclick = () => finish(false);
    dialog.oncancel = e => { e.preventDefault(); finish(false); };
    dialog.querySelector('.review-apply').onclick = () => finish(true);
    try {
      if (!window.monaco?.editor?.createDiffEditor) throw new Error('编辑器尚未加载，请关闭后重试。');
      before = monaco.editor.createModel(original, language);
      after = monaco.editor.createModel(proposed, language);
      diff = monaco.editor.createDiffEditor(dialog.querySelector('.review-editor'), {
        theme: 'vs', readOnly: true, originalEditable: false, renderSideBySide: false,
        automaticLayout: true, minimap: { enabled: false }, fontSize: 13,
        scrollBeyondLastLine: false, ignoreTrimWhitespace: false, renderIndicators: true,
        hideUnchangedRegions: { enabled: true, contextLineCount: 3, minimumLineCount: 6, revealLineCount: 10 },
        maxComputationTime: 5000, accessibilityVerbose: true,
      });
      let first = true;
      update = diff.onDidUpdateDiff(() => {
        const changes = diff.getLineChanges();
        const summary = dialog.querySelector('.review-summary');
        if (!changes) { summary.textContent = '差异计算未完成，请缩小代码块后重试。'; return; }
        const added = changes.reduce((sum, c) => sum + (c.modifiedEndLineNumber ? c.modifiedEndLineNumber - c.modifiedStartLineNumber + 1 : 0), 0);
        const removed = changes.reduce((sum, c) => sum + (c.originalEndLineNumber ? c.originalEndLineNumber - c.originalStartLineNumber + 1 : 0), 0);
        summary.textContent = changes.length ? `${changes.length} 处修改 · +${added} 行 / −${removed} 行` : original === proposed ? '与当前代码一致，无需写入' : '仅换行格式不同';
        dialog.querySelector('.review-apply').disabled = original === proposed;
        dialog.querySelector('.review-prev').disabled = !changes.length;
        dialog.querySelector('.review-next').disabled = !changes.length;
        if (first && changes.length) { diff.revealFirstDiff(); first = false; }
      });
      diff.setModel({ original: before, modified: after });
      dialog.querySelector('.review-prev').onclick = () => diff.goToDiff('previous');
      dialog.querySelector('.review-next').onclick = () => diff.goToDiff('next');
      dialog.querySelector('.review-layout').onclick = e => {
        sideBySide = !sideBySide; diff.updateOptions({ renderSideBySide: sideBySide });
        e.target.textContent = sideBySide ? '行内对比' : '并排对比';
      };
    } catch (e) {
      dialog.querySelector('.review-summary').textContent = e.message;
      dialog.querySelectorAll('.review-controls button').forEach(b => b.disabled = true);
    }
  });
}
