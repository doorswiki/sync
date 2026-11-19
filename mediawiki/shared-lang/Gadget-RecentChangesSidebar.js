// Adapted from https://dev.miraheze.org/wiki/Recent_changes_sidebar
mw.loader.using([ 'mediawiki.api', 'mediawiki.util' ], function () {
    const scriptPath = mw.config.get('wgScriptPath');
    const skin = mw.config.get('skin');
    const REFRESH_INTERVAL = 180000; // 3 minutes

    function articleUrl(title) {
        return mw.util.getUrl(title);
    }

    function contributionsUrl(user) {
        return mw.util.getUrl('Special:Contributions/' + user);
    }

    function recentChangesUrl() {
        return mw.util.getUrl('Special:RecentChanges');
    }

    function message(key, fallback) {
        const msg = mw.message(key);
        return msg.exists() ? msg.text() : fallback;
    }

    function formatAge(timestamp) {
        const timeDelta = Date.now() - Date.parse(timestamp);
        let timeString = Math.round(timeDelta / 60000) + 'm';

        if (timeDelta >= 3600000) {
            timeString = Math.round(timeDelta / 3600000) + 'h';
        }

        if (timeDelta >= 86400000) {
            timeString = Math.round(timeDelta / 86400000) + 'd';
        }

        return timeString;
    }

    function recentChangeItem(entry) {
        const user = entry.user;
        const userText = entry.anon === '' ? message('anonymous', 'anonymous') : user;

        const $timeLink = $('<a>', {
            href: scriptPath + `?diff=${entry.revid}`
        }).append(
            document.createTextNode(formatAge(entry.timestamp) + ' '),
            $('<span>', {
                class: 'rc-sidebar-ago',
                text: 'ago'
            })
        );

        return $('<li>', {
            class: 'mw-list-item rc-sidebar-item'
        }).append(
            $('<a>', {
                class: 'rc-sidebar-page',
                href: articleUrl(entry.title),
                text: entry.title
            }),
            $('<p>', {
                class: 'rc-sidebar-user'
            }).append(
                $('<a>', {
                    href: contributionsUrl(user),
                    text: userText
                }),
                document.createTextNode(' • '),
                $timeLink
            )
        );
    }

    function citizenShowMoreItem(body) {
        const $showMore = $('<li>', {
            class: 'mw-list-item'
        }).append(
            $('<a>', {
                'data-mw': 'interface',
                href: recentChangesUrl(),
                rel: 'nofollow',
                title: 'A list of recent changes in the wiki'
            }).append(
                $('<span>', {
                    text: 'Show more...'
                })
            )
        );

        $(body).append(
            $('<ul>', {
                class: 'rc-sidebar-list'
            }).append($showMore)
        );

        return $showMore;
    }

    function populateRecentChanges($showMore, changes) {
        // Remove the previous entries to prevent duplicates.
        $showMore
            .closest('ul')
            .children('.rc-sidebar-item')
            .remove();

        $showMore
            .children('a')
            .children('span')
            .last()
            .text('Show more...');

        $showMore.before(changes.map(function (entry) {
            return recentChangeItem(entry)[0];
        }));
    }

    function fetchRecentChanges() {
        return new mw.Api().get({
            action: 'query',
            list: 'recentchanges',
            rcprop: 'title|timestamp|user|ids',
            rcnamespace: '0',
            rclimit: '4',
            rctype: 'edit|new',
            rcshow: '!bot',
            rctoponly: '1',
            format: 'json',
            maxage: '120',
            smaxage: '120'
        });
    }

    function showRecentChanges($showMore) {
        if (!$showMore.length) {
            return;
        }

        function handleError(msg) {
            console.error('Failed to load recent changes:', msg);
        }

        function refresh() {
            fetchRecentChanges()
                .done(function (data) {
                    const changes = data.query && data.query.recentchanges
                        ? data.query.recentchanges
                        : [];

                    if (changes.length === 0) {
                        return;
                    }

                    populateRecentChanges($showMore, changes);
                })
                .fail(handleError);
        }

        // Initial fetch
        refresh();

        // Refresh automatically every 3 minutes
        setInterval(refresh, REFRESH_INTERVAL);
    }

    if (skin === 'citizen') {
        mw.hook('citizen.pageAside.register').add(function (data) {
            const body = data.register({
                id: 'rcsidebar',
                label: message('recentchanges', 'Recent changes'),
                placement: 'flow',
                order: 15
            });

            if (body) {
                showRecentChanges(citizenShowMoreItem(body));
            }
        });

        return;
    }

    // Wait for DOM ready
    $(function () {
        showRecentChanges($('#p-Recent_changes #n-recentchanges').first());
    });
});

// Citizen main menu Recent Changes
mw.loader.using('mediawiki.api', function () {
    const REFRESH_INTERVAL = 180000; // 3 minutes

    function fetchRecentChanges() {
        return new mw.Api().get({
            action: 'query',
            list: 'recentchanges',
            rcprop: 'title|ids',
            rcnamespace: '0',
            rclimit: '5',
            rctype: 'edit|new',
            rcshow: '!bot',
            rctoponly: '1',
            format: 'json',
            maxage: '120',
            smaxage: '120'
        });
    }

    function updateRecentChangesMenu($menu, changes) {
        const $list = $menu.find('.citizen-menu__content-list');

        $list.empty().append(changes.map(function (entry) {
            return $('<li>', {
                class: 'mw-list-item'
            }).append(
                $('<a>', {
                    href: mw.util.getUrl(entry.title)
                }).append(
                    $('<span>', {
                        text: entry.title
                    })
                )
            );
        }));
    }

    function createRecentChangesMenu(changes) {
        const $items = changes.map(function (entry) {
            return $('<li>', {
                class: 'mw-list-item'
            }).append(
                $('<a>', {
                    href: mw.util.getUrl(entry.title)
                }).append(
                    $('<span>', {
                        text: entry.title
                    })
                )
            );
        });

        const $menu = $('<nav>', {
            id: 'p-RCMenu',
            class: 'citizen-menu mw-portlet mw-portlet-RCMenu',
            'aria-label': 'Recent changes'
        }).append(
            $('<div>', {
                class: 'citizen-menu__heading',
                text: 'Recent changes'
            }),
            $('<div>', {
                class: 'citizen-menu__content'
            }).append(
                $('<ul>', {
                    class: 'citizen-menu__content-list'
                }).append($items)
            )
        );

        $('.citizen-main-menu.citizen-drawer__menu #p-External').before($menu);

        return $menu;
    }

    $(function () {
        if (!$('.citizen-main-menu.citizen-drawer__menu').length) {
            return;
        }

        function refreshMenu() {
            fetchRecentChanges()
                .done(function (data) {
                    const changes = data.query && data.query.recentchanges;

                    if (!changes || !changes.length) {
                        return;
                    }

                    let $menu = $('#p-RCMenu');

                    if ($menu.length) {
                        updateRecentChangesMenu($menu, changes);
                    } else {
                        createRecentChangesMenu(changes);
                    }
                })
                .fail(function (error) {
                    console.error('Failed to load recent changes menu:', error);
                });
        }

        // Initial fetch
        refreshMenu();

        // Refresh automatically every 3 minutes
        setInterval(refreshMenu, REFRESH_INTERVAL);
    });
});