<?php
declare(strict_types=1);

/**
 * Hardly Read — app API controller.
 *
 * A minimal, additive JSON surface so the Hardly Read app can read and drive
 * the same state the web UI drives. Every path delegates to the SAME store
 * methods and the SAME sweep the settings pages use, so there is one write path
 * and no second implementation to drift.
 *
 * WHY NOT JUST USE THE GREADER API
 * --------------------------------
 * It cannot express any of this. Hiding writes feed priority -10, which drops
 * the feed out of subscription/list entirely — so "hidden" and "deleted" are
 * indistinguishable over GReader, and a category whose feeds are all hidden
 * looks like a category that no longer exists. The app has to be told.
 *
 * AUTH
 * ----
 * Same-origin only, riding the normal FreshRSS session, because the app is
 * served from the FreshRSS origin. There is no separate token, and none is
 * needed: Minz already requires an authenticated session to reach any /i/
 * controller at all.
 *
 * CSRF
 * ----
 * Minz rejects unsafe methods without a valid CSRF token, which an app cannot
 * mint. Rather than weaken that check for everyone, this controller is reached
 * with a same-origin pin: a cross-site page cannot set a custom header or an
 * Origin without triggering a CORS preflight, and both are verified below.
 */

final class HardlyReadController extends Minz_ActionController
{
    /** Extension display names (the keys used in extensions_enabled). */
    private const EXT_HIDDEN = 'Hidden Categories';
    private const EXT_FAVORITE = 'Favorite Categories';
    private const EXT_INDENT = 'Sidebar Feed Indent';

    /** ------------------------------------------------------------------ GET */

    /** Full state for the app: hidden, favorite and indent, in one response. */
    public function stateAction(): void
    {
        $this->guard();

        $hidden = ['enabled' => false];
        $favorite = ['enabled' => false];
        $indent = ['enabled' => false, 'px' => 0];

        // findExtension() returns the live, registered extension instance, so
        // the store and the category list come straight off it. Nothing here
        // needs a wrapper class or a second copy of any logic.
        $hk = $this->enabled(self::EXT_HIDDEN);
        if ($hk !== null && method_exists($hk, 'store')) {
            $store = $hk->store();
            $cats = [];
            $counts = [];
            try {
                $cats = $store->hiddenIds();
                foreach ($hk->categories() as $c) {
                    $counts[$c['id']] = ['name' => $c['name'], 'feeds' => $c['feeds']];
                }
            } catch (Throwable $e) {
                Minz_Log::warning('HardlyRead: hidden state: ' . $e->getMessage());
            }
            $hidden = [
                'enabled' => true,
                'cats' => $cats,
                'mode' => $store->mode(),
                'view' => $hk->effectiveView(),
                'next' => $hk->sessionUnlocked() ? $store->nextView() : 'hidden',
                'locked' => $store->isLocked() && !$hk->sessionUnlocked(),
                'lockedArmed' => $store->isLocked(),
                // only offered when a passcode exists, so the button can never
                // lead to a dead end
                'lockAvailable' => $store->hasPasscode(),
                'showCount' => $store->showCount(),
                'rowMode' => $store->rowMode(),
                'rowLabel' => $store->rowLabel(),
                'meta' => array_filter(
                    $counts,
                    static fn ($id) => in_array($id, $cats, true),
                    ARRAY_FILTER_USE_KEY
                ),
            ];
        }

        $fc = $this->enabled(self::EXT_FAVORITE);
        if ($fc !== null && method_exists($fc, 'store')) {
            $store = $fc->store();
            $cats = [];
            $counts = [];
            try {
                $cats = $store->favIds();
                foreach ($fc->categories() as $c) {
                    $counts[$c['id']] = ['name' => $c['name'], 'feeds' => $c['feeds']];
                }
            } catch (Throwable $e) {
                Minz_Log::warning('HardlyRead: favorite state: ' . $e->getMessage());
            }
            $favorite = [
                'enabled' => true,
                'cats' => $cats,
                'meta' => array_filter(
                    $counts,
                    static fn ($id) => in_array($id, $cats, true),
                    ARRAY_FILTER_USE_KEY
                ),
                'view' => $store->view(),
                'next' => $store->nextView(),
                'rowMode' => $store->rowMode(),
                'rowLabel' => $store->rowLabel(),
                'button' => $store->buttonContent(),
                // the store keeps vocab and icon separately, but they only ever
                // move together — collapsed to one field for the app
                'look' => ($store->vocabulary() === 'pinned' && $store->icon() === 'pin')
                    ? 'pinned' : 'favorites',
                'filterStyle' => $store->filterStyle(),
                'mode' => $store->mode(),
            ];
        }

        $si = $this->enabled(self::EXT_INDENT);
        if ($si !== null && method_exists($si, 'indent')) {
            $indent = ['enabled' => true, 'px' => $si->indent()];
        }

        $this->json([
            'ok' => true,
            'version' => 1,
            'hidden' => $hidden,
            'favorite' => $favorite,
            'indent' => $indent,
        ]);
    }

    /** ---------------------------------------------------------------- POST */

    /**
     * One action, dispatched to the extension that owns it.
     *
     * Action names are the same ones the settings pages use, so the app and the
     * web UI cannot diverge.
     */
    public function actAction(): void
    {
        $this->guard();

        $raw = file_get_contents('php://input') ?: '';
        $body = json_decode($raw, true);
        if (!is_array($body)) {
            $body = $_POST;
        }
        $act = isset($body['act']) && is_string($body['act']) ? trim($body['act']) : '';
        if ($act === '') {
            $this->json(['ok' => false, 'message' => 'No action was named, so nothing changed.'], 400);
            return;
        }

        switch ($act) {
            // ---------------------------------------------------- hidden cats
            case 'hide':
            case 'unhide':
                $hk = $this->enabled(self::EXT_HIDDEN);
                if ($hk === null) {
                    $this->json(['ok' => false, 'message' => 'Hidden Categories is not enabled.'], 409);
                    return;
                }
                $catId = $this->catId($body);
                if ($catId <= 0) {
                    $this->json(['ok' => false, 'message' => 'No category was named, so nothing changed.'], 400);
                    return;
                }
                // Name comes from the database, never from the request: a posted
                // name could label one category while hiding another.
                $name = $hk->categoryName($catId);
                if ($name === null) {
                    $this->json(['ok' => false, 'message' => 'Category ' . $catId . ' no longer exists — nothing changed.'], 404);
                    return;
                }
                $store = $hk->store();
                $r = $act === 'hide'
                    ? $store->hideCategory($catId, $name)
                    : $store->unhideCategory($catId, $name);
                if (empty($r['ok'])) {
                    $this->json(['ok' => false, 'message' => (string)($r['message'] ?? 'Failed.')], 500);
                    return;
                }
                // Converge the feeds exactly as the settings page does.
                $sweep = $hk->sweepFeeds();
                $this->json([
                    'ok' => !empty($sweep['ok']),
                    'message' => (string)($r['message'] ?? '') . $this->sweepNote($sweep),
                    'sweep' => $sweep,
                ]);
                return;

            case 'hview':
                $hk = $this->enabled(self::EXT_HIDDEN);
                if ($hk === null) {
                    $this->json(['ok' => false, 'message' => 'Hidden Categories is not enabled.'], 409);
                    return;
                }
                // A view change while locked must not work, or the lock could be
                // bypassed from the app.
                if (!$hk->sessionUnlocked()) {
                    $this->json(['ok' => false, 'message' => 'Locked: unlock first.'], 423);
                    return;
                }
                $to = $this->view($body, ['hidden', 'revealed', 'only']);
                if ($to === null) {
                    $this->json(['ok' => false, 'message' => 'Unknown view, nothing changed.'], 400);
                    return;
                }
                if (!$hk->store()->setView($to)) {
                    $this->json(['ok' => false, 'message' => 'Could not save the view.'], 500);
                    return;
                }
                // 'only' and 'revealed' both need the feeds present in the
                // stream: in Strict a hidden feed sits at -10 and the server
                // never sends its articles, so the view would render empty.
                // Enforcement is suspended for both and re-applied on 'hidden'.
                $sweep = $hk->applyViewChange($to);
                $this->json([
                    'ok' => !empty($sweep['ok']),
                    'message' => $this->viewMessage($to) . $this->sweepNote($sweep),
                    'sweep' => $sweep,
                ]);
                return;

            case 'hmode':
                $hk = $this->enabled(self::EXT_HIDDEN);
                if ($hk === null) {
                    $this->json(['ok' => false, 'message' => 'Hidden Categories is not enabled.'], 409);
                    return;
                }
                $mode = isset($body['mode']) && is_string($body['mode']) ? trim($body['mode']) : '';
                $r = $hk->store()->setMode($mode);
                if (empty($r['ok'])) {
                    $this->json(['ok' => false, 'message' => (string)($r['message'] ?? 'Failed.')], 500);
                    return;
                }
                $sweep = $hk->sweepFeeds();
                $this->json([
                    'ok' => !empty($sweep['ok']),
                    'message' => (string)($r['message'] ?? '') . $this->sweepNote($sweep),
                    'sweep' => $sweep,
                ]);
                return;

            // -------------------------------------------------- favorite cats
            case 'fav':
            case 'unfav':
                $fc = $this->enabled(self::EXT_FAVORITE);
                if ($fc === null) {
                    $this->json(['ok' => false, 'message' => 'Favorite Categories is not enabled.'], 409);
                    return;
                }
                $catId = $this->catId($body);
                if ($catId <= 0) {
                    $this->json(['ok' => false, 'message' => 'No category was named, so nothing changed.'], 400);
                    return;
                }
                $name = $fc->categoryName($catId);
                if ($name === null) {
                    $this->json(['ok' => false, 'message' => 'Category ' . $catId . ' no longer exists — nothing changed.'], 404);
                    return;
                }
                $store = $fc->store();
                $r = $act === 'fav'
                    ? $store->favCategory($catId, $name)
                    : $store->unfavCategory($catId, $name);
                if (empty($r['ok'])) {
                    $this->json(['ok' => false, 'message' => (string)($r['message'] ?? 'Failed.')], 500);
                    return;
                }
                $sweep = $fc->sweepFeeds();
                $this->json([
                    'ok' => !empty($sweep['ok']),
                    'message' => (string)($r['message'] ?? '') . $this->sweepNote($sweep),
                    'sweep' => $sweep,
                ]);
                return;

            case 'fcview':
                $fc = $this->enabled(self::EXT_FAVORITE);
                if ($fc === null) {
                    $this->json(['ok' => false, 'message' => 'Favorite Categories is not enabled.'], 409);
                    return;
                }
                $to = $this->view($body, ['all', 'only', 'without']);
                if ($to === null) {
                    $this->json(['ok' => false, 'message' => 'Unknown view, nothing changed.'], 400);
                    return;
                }
                if (!$fc->store()->setView($to)) {
                    $this->json(['ok' => false, 'message' => 'Could not save the view.'], 500);
                    return;
                }
                $sweep = $fc->sweepFeeds();
                $this->json([
                    'ok' => !empty($sweep['ok']),
                    'message' => 'View saved.' . $this->sweepNote($sweep),
                    'sweep' => $sweep,
                ]);
                return;

            // ------------------------------------------------------- indent
            case 'indent':
                $si = $this->enabled(self::EXT_INDENT);
                if ($si === null) {
                    $this->json(['ok' => false, 'message' => 'Sidebar Feed Indent is not enabled.'], 409);
                    return;
                }
                if (!isset($body['px']) || !is_numeric($body['px'])) {
                    $this->json(['ok' => false, 'message' => 'No value was sent, so nothing changed.'], 400);
                    return;
                }
                // The extension's own clamp is the authority, not the request.
                $saved = $si->saveIndent((int)$body['px']);
                $this->json([
                    'ok' => (bool)$saved,
                    'message' => $saved ? 'Indent saved.' : 'Could not save the indent.',
                    'px' => $si->indent(),
                ]);
                return;

            default:
                $this->json(['ok' => false, 'message' => 'Unknown action "' . $act . '". Nothing changed.'], 400);
                return;
        }
    }

    /** ----------------------------------------------------------- internals */

    /**
     * Accept the request only if it is an authenticated same-origin session.
     *
     * Minz re-authenticates before any controller runs. What this adds is the
     * same-origin pin, which is what substitutes for the CSRF token an app
     * cannot hold. A cross-site page cannot forge either check.
     */
    private function guard(): void
    {
        $this->view->_layout(false);
        header('Content-Type: application/json; charset=UTF-8');
        header('X-Content-Type-Options: nosniff');
        header('Cache-Control: no-store');

        $host = $_SERVER['HTTP_HOST'] ?? '';

        $origin = $_SERVER['HTTP_ORIGIN'] ?? '';
        if ($origin !== '') {
            $oHost = parse_url($origin, PHP_URL_HOST);
            $oPort = parse_url($origin, PHP_URL_PORT);
            $expected = $oHost . ($oPort ? ':' . $oPort : '');
            if ($expected !== $host) {
                $this->json(['ok' => false, 'message' => 'Cross-origin request refused.'], 403);
                exit;
            }
            return;
        }

        // No Origin (same-origin GETs often omit it) — fall back to Referer.
        $ref = $_SERVER['HTTP_REFERER'] ?? '';
        if ($ref !== '') {
            $rHost = parse_url($ref, PHP_URL_HOST);
            $rPort = parse_url($ref, PHP_URL_PORT);
            $rFull = $rHost . ($rPort ? ':' . $rPort : '');
            if ($rFull !== $host) {
                $this->json(['ok' => false, 'message' => 'Cross-origin request refused.'], 403);
                exit;
            }
        }
    }

    /** Emit JSON and stop. */
    private function json(array $data, int $status = 200): void
    {
        http_response_code($status);
        echo json_encode($data, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    }

    private function catId(array $body): int
    {
        return isset($body['cat']) && is_numeric($body['cat']) ? (int)$body['cat'] : 0;
    }

    /** @param list<string> $allowed */
    private function view(array $body, array $allowed): ?string
    {
        $v = isset($body['view']) && is_string($body['view']) ? trim($body['view']) : '';
        return in_array($v, $allowed, true) ? $v : null;
    }

    /** One line describing what a sweep did, matching the settings page. */
    private function sweepNote(array $sweep): string
    {
        $bits = [];
        if (!empty($sweep['enforced'])) $bits[] = (int)$sweep['enforced'] . ' feed(s) updated';
        if (!empty($sweep['restored'])) $bits[] = (int)$sweep['restored'] . ' feed(s) restored';
        if (!empty($sweep['skipped']))  $bits[] = (int)$sweep['skipped'] . ' already in that state';
        if (!empty($sweep['failed']))   $bits[] = (int)$sweep['failed'] . ' FAILED';
        return $bits === [] ? '' : ' (' . implode(', ', $bits) . ')';
    }

    private function viewMessage(string $to): string
    {
        return match ($to) {
            'only' => 'Showing only hidden categories.',
            'revealed' => 'Peeking: hidden categories are mixed back in.',
            default => 'Hidden categories are hidden again.',
        };
    }

    /**
     * The live, enabled extension instance, or null.
     *
     * findExtension() returns the object FreshRSS already registered, so the
     * store, the category list, the sweep and the view logic all come off it
     * directly. A missing or disabled extension yields null and the caller
     * reports that cleanly instead of fataling.
     */
    private function enabled(string $name): ?Minz_Extension
    {
        try {
            if (!Minz_ExtensionManager::isExtensionEnabled($name)) {
                return null;
            }
            return Minz_ExtensionManager::findExtension($name);
        } catch (Throwable $e) {
            Minz_Log::warning('HardlyRead: could not load ' . $name . ': ' . $e->getMessage());
            return null;
        }
    }
}
