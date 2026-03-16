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
    }
};
