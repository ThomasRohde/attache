// highlight.js initialization + scroll helpers for Blazor interop
window.attache = {
    highlightCode: function () {
        document.querySelectorAll('pre code:not(.hljs)').forEach(function (block) {
            hljs.highlightElement(block);
        });
    },

    scrollToBottom: function (elementId) {
        var el = document.getElementById(elementId);
        if (el) {
            el.scrollTop = el.scrollHeight;
        }
    },

    autoResizeTextarea: function (element) {
        if (element) {
            element.style.height = 'auto';
            element.style.height = Math.min(element.scrollHeight, 120) + 'px';
        }
    },

    // Composer textarea: all keyboard logic lives here so we can
    // call e.preventDefault() synchronously.
    initComposer: function (element, dotnetRef) {
        if (!element) return;
        element._slashMenuOpen = false;
        // Focus immediately, then retry — BlazorWebView may not be ready yet
        element.focus();
        setTimeout(function () { element.focus(); }, 200);
        setTimeout(function () { element.focus(); }, 600);

        element._composerHandler = function (e) {
            if (element._slashMenuOpen) {
                switch (e.key) {
                    case 'ArrowDown':
                    case 'ArrowUp':
                    case 'Tab':
                    case 'Escape':
                        e.preventDefault();
                        dotnetRef.invokeMethodAsync('HandleSlashKey', e.key);
                        return;
                    case 'Enter':
                        e.preventDefault();
                        dotnetRef.invokeMethodAsync('HandleSlashKey', 'Enter');
                        return;
                }
            }

            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                var text = element.value.trim();
                if (text) {
                    dotnetRef.invokeMethodAsync('JsSend', text);
                    element.value = '';
                    element.style.height = '';
                }
            }
        };
        element.addEventListener('keydown', element._composerHandler);

        // Clipboard paste — intercept image pastes
        element._pasteHandler = function (e) {
            if (!e.clipboardData || !e.clipboardData.items) return;
            for (var i = 0; i < e.clipboardData.items.length; i++) {
                var item = e.clipboardData.items[i];
                if (item.type.indexOf('image/') === 0) {
                    e.preventDefault();
                    var blob = item.getAsFile();
                    if (!blob) continue;
                    var reader = new FileReader();
                    reader.onload = function () {
                        // result is "data:image/png;base64,..."
                        var base64 = reader.result.split(',')[1];
                        var ext = blob.type.split('/')[1] || 'png';
                        if (ext === 'jpeg') ext = 'jpg';
                        dotnetRef.invokeMethodAsync('JsImagePasted', base64, ext);
                    };
                    reader.readAsDataURL(blob);
                    break; // only handle one image
                }
            }
        };
        element.addEventListener('paste', element._pasteHandler);

        // Drag-and-drop file attachment
        var composerDiv = element.closest('.composer');
        if (composerDiv) {
            element._dragOverHandler = function (e) {
                e.preventDefault();
                e.stopPropagation();
                composerDiv.classList.add('drag-over');
            };
            element._dragLeaveHandler = function (e) {
                e.preventDefault();
                e.stopPropagation();
                composerDiv.classList.remove('drag-over');
            };
            element._dropHandler = function (e) {
                e.preventDefault();
                e.stopPropagation();
                composerDiv.classList.remove('drag-over');
                var paths = [];
                if (e.dataTransfer && e.dataTransfer.files) {
                    for (var i = 0; i < e.dataTransfer.files.length; i++) {
                        var f = e.dataTransfer.files[i];
                        // In Electron/WebView2, files have a .path property
                        if (f.path) {
                            paths.push(f.path);
                        }
                    }
                }
                if (paths.length > 0) {
                    dotnetRef.invokeMethodAsync('JsFilesDropped', paths);
                }
            };
            composerDiv.addEventListener('dragover', element._dragOverHandler);
            composerDiv.addEventListener('dragleave', element._dragLeaveHandler);
            composerDiv.addEventListener('drop', element._dropHandler);
            element._composerDiv = composerDiv;
        }
    },

    setSlashMenuOpen: function (element, open) {
        if (element) element._slashMenuOpen = open;
    },

    clearComposer: function (element) {
        if (element) {
            element.value = '';
            element.style.height = '';
            element.focus();
        }
    },

    focusComposer: function (element) {
        if (element) element.focus();
    },

    setComposerValue: function (element, value) {
        if (element) {
            element.value = value;
            element.focus();
        }
    },

    disposeComposer: function (element) {
        if (element && element._composerHandler) {
            element.removeEventListener('keydown', element._composerHandler);
            delete element._composerHandler;
        }
        if (element && element._pasteHandler) {
            element.removeEventListener('paste', element._pasteHandler);
            delete element._pasteHandler;
        }
        if (element && element._composerDiv) {
            var div = element._composerDiv;
            if (element._dragOverHandler) div.removeEventListener('dragover', element._dragOverHandler);
            if (element._dragLeaveHandler) div.removeEventListener('dragleave', element._dragLeaveHandler);
            if (element._dropHandler) div.removeEventListener('drop', element._dropHandler);
            delete element._composerDiv;
            delete element._dragOverHandler;
            delete element._dragLeaveHandler;
            delete element._dropHandler;
        }
    }
};
