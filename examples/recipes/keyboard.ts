// Browser side: keep fixed bars and focused fields above the on-screen keyboard in Android WebView
// and iOS WKWebView. Call once at app start (client only; it does nothing during SSR).

import { keepFocusedInputVisible, watchViewport } from '../../src/viewport/index.ts';

export const setupKeyboard = () => {
    const stopViewport = watchViewport({
        onChange: ({ keyboardOpen, keyboardHeight }) => {
            document.body.classList.toggle('keyboard-open', keyboardOpen);
            console.debug(`keyboard ${keyboardOpen ? `open, ${keyboardHeight}px` : 'closed'}`);
        },
    });
    const stopFocus = keepFocusedInputVisible({ margin: 24 });

    return () => {
        stopViewport();
        stopFocus();
    };
};
