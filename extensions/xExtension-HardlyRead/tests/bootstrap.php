<?php
declare(strict_types=1);

/**
 * Bootstrap for the fast router suite.
 *
 * Deliberately no FreshRSS, no composer autoload, no superglobals: the router
 * is pure PHP, so booting it is a `require_once` and a handful of fakes.
 *
 * Also used by the root composer script:
 *   phpunit -c extensions/xExtension-HardlyRead/phpunit.xml
 */

require_once dirname(__DIR__) . '/lib/HardlyReadApi.php';
require_once __DIR__ . '/Fakes/FakeHiddenCategoriesStore.php';
require_once __DIR__ . '/Fakes/FakeHiddenCategoriesReadOnly.php';
require_once __DIR__ . '/Fakes/FakeHiddenCategories.php';
require_once __DIR__ . '/Fakes/FakeFavoritesStore.php';
require_once __DIR__ . '/Fakes/FakeFavoriteCategoriesReadOnly.php';
require_once __DIR__ . '/Fakes/FakeFavoriteCategories.php';
require_once __DIR__ . '/Fakes/FakeSidebarIndent.php';
require_once __DIR__ . '/Fakes/FakeCategoryPositions.php';
