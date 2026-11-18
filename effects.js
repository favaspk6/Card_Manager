/* Cursor-follow light on glass panels */
(function () {
    var raf = 0;
    document.addEventListener('pointermove', function (e) {
        if (raf) return;
        raf = requestAnimationFrame(function () {
            raf = 0;
            var el = e.target.closest && e.target.closest('.panel, .panel-gr, [class*="bg-[#0f121a]"]');
            if (!el) return;
            var r = el.getBoundingClientRect();
            el.style.setProperty('--px', (e.clientX - r.left) + 'px');
            el.style.setProperty('--py', (e.clientY - r.top) + 'px');
        });
    }, { passive: true });
})();

    // Page scroll lock: while any popup, dialog or the mobile sidebar is open, the page behind cannot scroll.
    (function () {
        var SELECTOR = '[id$="-modal"], #dd-wp-multi, #auth-gate, #sidebar-backdrop';
        var locked = false, savedY = 0, queued = false;
        function visible(el) {
            if (!el || el.classList.contains('hidden')) return false;
            var cs = window.getComputedStyle(el);
            return cs.display !== 'none' && cs.visibility !== 'hidden';
        }
        function anyOpen() {
            var nodes = document.querySelectorAll(SELECTOR);
            for (var i = 0; i < nodes.length; i++) if (visible(nodes[i])) return true;
            return false;
        }
        function lock() {
            if (locked) return;
            locked = true;
            savedY = window.pageYOffset || document.documentElement.scrollTop || 0;
            document.body.style.top = (-savedY) + 'px';
            document.documentElement.classList.add('dd-scroll-locked');
        }
        function unlock() {
            if (!locked) return;
            locked = false;
            document.documentElement.classList.remove('dd-scroll-locked');
            document.body.style.top = '';
            window.scrollTo(0, savedY);
        }
        function check() {
            queued = false;
            if (anyOpen()) lock(); else unlock();
        }
        function schedule() {
            if (queued) return;
            queued = true;
            (window.requestAnimationFrame || setTimeout)(check);
        }
        new MutationObserver(schedule).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'style', 'hidden'] });
        window.addEventListener('resize', schedule);
        schedule();
    })();
