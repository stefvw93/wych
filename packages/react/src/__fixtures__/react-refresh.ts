/**
 * React's Fast Refresh runtime, hooked into the page before `react-dom` loads.
 *
 * A test that drives a refresh cycle imports this module first. ESM evaluates
 * imports in order, and `react-dom` registers itself with the devtools hook
 * when its own module runs, so the hook has to exist by then or the runtime
 * never learns which roots to refresh.
 */
import RefreshRuntime from "react-refresh/runtime";

RefreshRuntime.injectIntoGlobalHook(window);

export { RefreshRuntime };
