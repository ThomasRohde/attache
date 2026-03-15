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
    }
};
