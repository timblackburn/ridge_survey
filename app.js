/*================================================================
    APP.JS - Main JavaScript for the Historic Survey Map
    (CSS-Only Adaptive Version)
================================================================*/

// ---------------------------------------------------------------
//  1. CONFIGURATION & INITIALIZATION
// ---------------------------------------------------------------

// Store references to our key GeoJSON data
let surveyData = null;
let nationalDistricts = null;
let chicagoDistricts = null;
let allDistricts = []; // Combined district data

// Store references to our Leaflet layers
let surveyLayer = null; // This will be the layer we add/remove
let baseSurveyLayer = null; // The original, full data
let nationalDistrictsLayer = null;
let chicagoDistrictsLayer = null;
let selectedDistrictLayer = null;
let selectedBuildingLayer = null;
let highlightLayer = null;
let locationMarker = null; // For the "you are here" dot

// Map from district NAME -> array of survey feature objects inside that district
let districtFeatureMap = {};
// When set to a district NAME, the app is 'locked' to that district view
// and should continue showing the district boundary and only its houses.
let activeDistrictContext = null;
// Reverse index: BLDG_ID -> district NAME (for O(1) lookup)
let bldgIdToDistrict = {};
let highlightOrigin = null;
let highlightControlButton = null;
let highlightFeatureCache = {};
let lastListHash = ''; // Track the last list view for navigation

// Lightweight performance counters for heavy Turf operations. Exposed via
// `window.getPerfStats()` so you can inspect counts and cumulative time.
const perfStats = {
    centroidCalls: 0, centroidTime: 0,
    booleanCalls: 0, booleanTime: 0,
    diffCalls: 0, diffTime: 0
};
perfStats._lastStoreTime = 0;

function iCentroid(feature) {
    const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    let res = null;
    try {
        res = turf.centroid(feature);
    } finally {
        const elapsed = ((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - t0;
        perfStats.centroidCalls++;
        perfStats.centroidTime += elapsed;
        maybePersistPerfStats();
    }
    return res;
}

function iBooleanPointInPolygon(pt, poly) {
    const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    let res = false;
    try {
        res = turf.booleanPointInPolygon(pt, poly);
    } catch (e) {
        res = false;
    } finally {
        const elapsed = ((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - t0;
        perfStats.booleanCalls++;
        perfStats.booleanTime += elapsed;
    }
    return res;
}

function iDifference(a, b) {
    const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    let res = null;
    try {
        res = turf.difference(a, b);
    } finally {
        const elapsed = ((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - t0;
        perfStats.diffCalls++;
        perfStats.diffTime += elapsed;
        maybePersistPerfStats();
    }
    return res;
}

// Expose a helper to inspect perf stats in the console
window.getPerfStats = function () { return Object.assign({}, perfStats); };
window.resetPerfStats = function () { perfStats.centroidCalls = 0; perfStats.centroidTime = 0; perfStats.booleanCalls = 0; perfStats.booleanTime = 0; perfStats.diffCalls = 0; perfStats.diffTime = 0; };

function maybePersistPerfStats() {
    try {
        const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        if (!perfStats._lastStoreTime || (now - perfStats._lastStoreTime) > 1000) {
            // store a minimal snapshot to localStorage so it's available after a freeze
            const snap = {
                t: Date.now(),
                centroidCalls: perfStats.centroidCalls,
                centroidTime: perfStats.centroidTime,
                booleanCalls: perfStats.booleanCalls,
                booleanTime: perfStats.booleanTime,
                diffCalls: perfStats.diffCalls,
                diffTime: perfStats.diffTime
            };
            try { localStorage.setItem('ridge_perf_stats', JSON.stringify(snap)); } catch (e) { /* ignore storage errors */ }
            perfStats._lastStoreTime = now;
        }
    } catch (e) { /* swallow */ }
}

// Create a small on-screen badge for perf stats so you can see counts even if
// the DevTools console becomes unresponsive. The badge can be closed.
// NOTE: The on-screen performance badge was removed. Instrumentation
// counters (perfStats, iCentroid/iDifference wrappers) remain available
// for debugging via `window.getPerfStats()` and persisted snapshots in
// localStorage, but the UI overlay has been intentionally removed.

// Timer used to debounce map move events
let mapMoveTimer = null;

// Tracks the "Follow map" toggle state
let isMapFollowEnabled = false; // State for "Follow map" toggle
let currentNavigationList = []; // Stores the current list of features for next/prev navigation
let savedScrollPositions = {}; // Stores scroll positions for list panels by route hash
let cachedImageDimensions = null; // Caches property image dimensions to prevent content jumping
// Tracks the location button state
let locationMode = 'off'; // 'off', 'following', 'error'

// Get references to key DOM elements
let appContainer, bottomSheet, sheetContent, sheetHandle, searchInput,
    locationButton, filterPillsContainer, searchResultsDropdown, rightSheet, rightSheetContent;

// Loading flag
let isDataLoaded = false;
let currentDropdownResults = []; // For "Enter" key logic
let appHistory = []; // For custom history tracking

// Google Analytics / GTM tracking helper
function trackEvent(eventName, eventParams = {}) {
    if (typeof window.dataLayer !== 'undefined') {
        window.dataLayer.push({
            'event': eventName,
            ...eventParams
        });
    }
}


// This is the config object you can edit
const districtConfig = {
    "Ridge Historic District": { color: "#E63946" }, // Red
    "Brainerd Bungalow Historic District": { color: "#F4A261" }, // Orange
    "Walter Burley Griffin Place": { color: "#457B9D" }, // Blue
    "Longwood Drive": { color: "#6A4C93" }, // Purple
    "Beverly/Morgan Park Railroad Station": { color: "#4CB944" } // Green
};

// Fallback palette for any districts not in the config
const districtFallbackPalette = [
    '#E63946', '#457B9D', '#F4A261', '#6A4C93', '#4CB944'
];

// Multiplier to increase how far we nudge the map left when the right
// property overlay is open. Tune this value to tweak the visual center.
const RIGHT_PANEL_OFFSET_MULTIPLIER = 1.05;

// Load building styles
fetch('building_styles.json')
    .then(response => response.json())
    .then(data => {
        window.buildingStyles = data;
    })
    .catch(error => console.error('Error loading building styles:', error));

// Initialize the map
const map = L.map('map', {
    zoomControl: false,
    scrollWheelZoom: true,
    tap: false // Fix for mobile tap issues
}).setView([41.71, -87.67], 13);

L.control.zoom({ position: 'topright' }).addTo(map);

L.tileLayer('https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png', {
    attribution: '© <a href="https://www.openstreetmap.org/">OpenStreetMap</a> contributors — Humanitarian style by HOT',
    maxZoom: 19
}).addTo(map);

// Create panes for layer ordering
map.createPane('nationalDistrictPane');
map.getPane('nationalDistrictPane').style.zIndex = 410;
map.createPane('localDistrictPane');
map.getPane('localDistrictPane').style.zIndex = 420;
map.createPane('buildingPane');
map.getPane('buildingPane').style.zIndex = 430;
map.createPane('selectedDistrictPane');
map.getPane('selectedDistrictPane').style.zIndex = 440;
map.createPane('highlightPane');
map.getPane('highlightPane').style.zIndex = 450;
map.createPane('locationPane');
map.getPane('locationPane').style.zIndex = 500;


// ---------------------------------------------------------------
//  2. CORE APP LOGIC (runs immediately)
// ---------------------------------------------------------------

initializeApp();

function initializeApp() {
    console.log("Initializing Leaflet app...");

    // Get DOM elements
    appContainer = document.getElementById('app-container');
    bottomSheet = document.getElementById('bottom-sheet');
    sheetContent = document.querySelector('.sheet-content');
    sheetHandle = document.querySelector('.handle');
    searchInput = document.querySelector('#search-bar input');
    locationButton = document.getElementById('location-button');
    filterPillsContainer = document.getElementById('filter-pills');
    searchResultsDropdown = document.getElementById('search-results-dropdown');
    rightSheet = document.getElementById('right-sheet');
    rightSheetContent = rightSheet ? rightSheet.querySelector('.sheet-content-right') : null;

    // Move pills to side panel on desktop load
    handleResize();

    showDefaultPanel();
    setupEventListeners();
    loadDataSources();
    // Ensure initial visual center accounts for any right-side overlay.
    // Delay slightly so layout/CSS settle (desktop panel widths apply).
    setTimeout(() => {
        try { smartSetView([41.71, -87.67], 13); } catch (e) { }
    }, 80);
}

/**
 * Loads all GeoJSON files and adds them to the map as Leaflet layers.
 */
async function loadDataSources() {
    try {
        const [surveyRes, nationalRes, chicagoRes] = await Promise.all([
            fetch('survey_refactor1_filtered.geojson'),
            fetch('national_districts.geojson'),
            fetch('chicago_districts.geojson')
        ]);

        surveyData = await surveyRes.json();
        nationalDistricts = await nationalRes.json();
        chicagoDistricts = await chicagoRes.json();

        // REMOVE subtraction logic: just combine all districts as-is
        allDistricts = [...nationalDistricts.features, ...chicagoDistricts.features];

        // Pre-process survey data (for decades) and compute centroids once
        // so we don't call turf.centroid on every map move (expensive).
        preprocessSurveyData();

        // Build a mapping from district NAME -> array of survey features
        // contained within that district. This is computed once after data
        // load so switching districts is fast (avoids scanning the whole
        // survey dataset on each click).
        try {
            districtFeatureMap = {};
            // Only iterate over districts that have a NAME property
            allDistricts.forEach(d => {
                const name = (d && d.properties && (d.properties.NAME || d.properties.name)) || null;
                if (name) districtFeatureMap[name] = [];
            });

            // For each district, collect features whose precomputed centroid
            // lies inside the district geometry. Also populate a reverse
            // index from building id -> district name for fast lookups.
            bldgIdToDistrict = {};
            for (const d of allDistricts) {
                try {
                    const name = (d && d.properties && (d.properties.NAME || d.properties.name)) || null;
                    if (!name) continue;
                    const geom = d.geometry;
                    if (!geom) continue;

                    for (const f of surveyData.features) {
                        try {
                            let lat, lng;
                            if (f._centroid && typeof f._centroid.lat === 'number') {
                                lat = f._centroid.lat; lng = f._centroid.lng;
                            } else {
                                const c = iCentroid(f);
                                if (c && c.geometry && c.geometry.coordinates) {
                                    lng = c.geometry.coordinates[0];
                                    lat = c.geometry.coordinates[1];
                                    f._centroid = { lng, lat };
                                } else {
                                    continue;
                                }
                            }

                            const pt = { type: 'Feature', geometry: { type: 'Point', coordinates: [lng, lat] } };
                            if (iBooleanPointInPolygon(pt, geom)) {
                                districtFeatureMap[name].push(f);
                                try {
                                    const id = f && f.properties && f.properties.BLDG_ID;
                                    if (typeof id !== 'undefined' && id !== null) {
                                        // Only set if not already present so first match wins
                                        if (!bldgIdToDistrict[id]) bldgIdToDistrict[id] = name;
                                    }
                                } catch (e) { }
                            }
                        } catch (e) {
                            // ignore individual failures
                        }
                    }
                } catch (e) {
                    // ignore per-district failures
                }
            }
        } catch (e) {
            console.warn('Could not precompute district->feature mapping.', e && e.message ? e.message : e);
            districtFeatureMap = {};
        }

        console.log("Data loaded and pre-processed");

        nationalDistrictsLayer = L.geoJSON(nationalDistricts, {
            style: (feature) => getDistrictStyle(feature, 0.2),
            interactive: false,
            pane: 'nationalDistrictPane'
        }).addTo(map);

        chicagoDistrictsLayer = L.geoJSON(chicagoDistricts, {
            style: (feature) => getDistrictStyle(feature, 0.2),
            interactive: false,
            pane: 'localDistrictPane'
        }).addTo(map);

        baseSurveyLayer = L.geoJSON(surveyData, {
            onEachFeature: (feature, layer) => {
                layer.on('click', (e) => {
                    L.DomEvent.stopPropagation(e);
                    trackEvent('map_feature_click', {
                        property_id: feature.properties.BLDG_ID,
                        color_code: feature.properties.CHRS_Rating || 'N/A'
                    });
                    window.location.hash = `#property/${feature.properties.BLDG_ID}`;
                });
            },
            pane: 'buildingPane'
        });

        updateSurveyLayer('default');

        isDataLoaded = true;
        handleHashChange();

    } catch (error) {
        console.error("Error loading data sources:", error);
        sheetContent.innerHTML = `
            <div class="sheet-header"><h3>Error</h3></div>
            <div class="scrollable-content"><p>Could not load map data.</p></div>
        `;
        toggleBottomSheet(true);
    }
}

/**
 * Sets up all the click handlers for the UI.
 */
function setupEventListeners() {
    let clickTimer = null;

    // Click handler for the bottom panel's handle (mobile only)
    sheetHandle.addEventListener('click', () => {
        if (window.innerWidth < 768) {
            toggleBottomSheet();
        }
    });

    // Main hash change router (wrapped for lightweight debugging)
    window.addEventListener('hashchange', (e) => {
        console.debug('[DEBUG] hashchange event ->', window.location.hash);
        try { handleHashChange(e); } catch (err) { console.error('Error in handleHashChange wrapper', err); }
    });

    // Listen for screen resize to move UI elements
    window.addEventListener('resize', handleResize);

    // Pill clicks
    document.querySelectorAll('#filter-pills .pill').forEach(pill => {
        pill.addEventListener('click', (e) => {
            const filter = e.currentTarget.dataset.filter;
            let currentHash = window.location.hash;

            // On mobile, expand panel when pill is tapped
            if (window.innerWidth < 768) {
                bottomSheet.classList.add('expanded');
            }

            // If already on this route, just expand panel and return (don't navigate)
            if (filter === 'districts' && currentHash === '#districts') {
                return; // Stay on districts, panel already expanded above
            } else if (filter === 'landmarks' && currentHash === '#landmarks') {
                return; // Stay on landmarks, panel already expanded above
            } else if (filter === 'survey' && currentHash.startsWith('#survey')) {
                return; // Stay on survey, panel already expanded above
            } else {
                window.location.hash = `#${filter}`;
            }
        });
    });

    // Search input
    searchInput.addEventListener('input', (e) => {
        showSearchDropdown(e.target.value);
    });

    searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            if (currentDropdownResults.length === 1) {
                // If one result, attempt to show it (respecting current filters)
                attemptShowProperty(currentDropdownResults[0].properties.BLDG_ID);
                clearSearchDropdown();
            } else {
                // Otherwise, perform a full search
                window.location.hash = `#search/${encodeURIComponent(e.target.value)}`;
                clearSearchDropdown();
            }
        }
    });

    // Close dropdown when clicking outside
    document.addEventListener('click', (e) => {
        if (!e.target.closest('#search-bar')) {
            clearSearchDropdown();
        }
    });

    // Map single-click handler
    map.on('click', (e) => {
        // If we're currently locked to a district context, or we're on a
        // district page, or a district highlight exists, ignore map clicks
        // so the user remains in that district view even if they click
        // the map away from buildings.
        const currentHash = window.location.hash || '';
        // Ignore map clicks if we are in a specific context that should be preserved
        if (activeDistrictContext ||
            currentHash.startsWith('#district/') ||
            selectedDistrictLayer ||
            currentHash.startsWith('#survey') ||
            currentHash === '#landmarks' ||
            currentHash === '#districts' ||
            currentHash.startsWith('#search/') ||
            currentHash.startsWith('#property/')
        ) return;
        if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
        clickTimer = setTimeout(() => {
            // Only navigate back to home if the click was on the bare map
            // background (tiles or container). Clicking on vector paths,
            // markers, or other interactive elements should not trigger
            // a navigation.
            try {
                const target = e && e.originalEvent && e.originalEvent.target;
                const cls = target && target.classList ? target.classList : null;
                const isMapBackground = cls && (cls.contains('leaflet-container') || cls.contains('leaflet-tile'));

                // *** FIX: Don't navigate home if we are already there ***
                const isAlreadyHome = !currentHash || currentHash === '#' || currentHash === '';

                if (isMapBackground && !selectedDistrictLayer && !activeDistrictContext && !isAlreadyHome) {
                    navigateHomeWithTrace('map-click: background');
                }
            } catch (err) {
                // If any error occurs, don't aggressively navigate away.
                console.debug('map click handler error', err);
            }
            clickTimer = null;
        }, 250);
    });

    // Map double-click handler
    map.on('dblclick', (e) => {
        if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
    });


    // *** MODIFIED: Delegated listener attached to the panel itself ***
    bottomSheet.addEventListener('click', function (e) {
        const highlightBtn = e.target.closest('.highlight-toggle');
        if (highlightBtn) {
            e.stopPropagation();
            e.preventDefault();
            handleHighlightToggle(highlightBtn);
            return;
        }

        // Follow map toggle
        if (e.target.id === 'follow-map-toggle') {
            isMapFollowEnabled = !isMapFollowEnabled;
            console.debug('[DEBUG] follow-map toggled, now:', isMapFollowEnabled);

            // Immediately hide/show navigation buttons in property cards
            const navContainers = document.querySelectorAll('.property-nav, .desktop-nav-float');
            navContainers.forEach(nav => {
                nav.style.display = isMapFollowEnabled ? 'none' : '';
            });

            // Track Follow Map toggle
            trackEvent('follow_map_toggle', {
                action: isMapFollowEnabled ? 'enabled' : 'disabled',
                current_route: window.location.hash || '/'
            });

            // Refresh the current panel content without changing map view.
            refreshPanel();
        }

        // Back button: go up to main view if already at top-level panel
        if (e.target.classList.contains('back-button')) {
            const currentHash = window.location.hash || '';
            const lastNonProp = getLastNonPropertyHash();
            const isTopLevelPanel = currentHash === '#districts' || currentHash === '#landmarks' || currentHash === '#survey';

            // Handle survey subroutes with hierarchical back navigation
            if (currentHash.startsWith('#survey/color/')) {
                navigateToPanel('#survey/color');
                return;
            }
            if (currentHash.startsWith('#survey/decade/')) {
                navigateToPanel('#survey/decade');
                return;
            }
            if (currentHash.startsWith('#survey/style/')) {
                navigateToPanel('#survey/style');
                return;
            }
            if (currentHash.startsWith('#survey/architect/')) {
                navigateToPanel('#survey/architect');
                return;
            }
            if (currentHash === '#survey/color' || currentHash === '#survey/decade' || currentHash === '#survey/style' || currentHash === '#survey/architect') {
                navigateToPanel('#survey');
                return;
            }

            if (isTopLevelPanel) {
                navigateHomeWithTrace('back-button: top-level panel');
            } else {
                const shouldGoToDistricts = currentHash.startsWith('#district/') || activeDistrictContext || selectedDistrictLayer || (lastNonProp && (lastNonProp === '#districts' || lastNonProp.startsWith('#district/')));
                if (shouldGoToDistricts) {
                    navigateToPanel('#districts');
                } else {
                    // If last non-property was landmarks or survey, honor that
                    const lastNonProp = getLastNonPropertyHash();
                    if (lastNonProp && (lastNonProp === '#landmarks' || lastNonProp.startsWith('#survey'))) {
                        if (lastNonProp === '#landmarks') navigateToPanel('#landmarks');
                        else navigateToPanel('#survey');
                    } else {
                        navigateHomeWithTrace('back-button (bottomSheet)');
                    }
                }
            }
        }

        // *** NEW: Close property button ***
        if (e.target.classList.contains('close-property-button')) {
            e.preventDefault();

            // Pop the current property view from history if it's there
            if (appHistory.length > 0 && appHistory[appHistory.length - 1].startsWith('#property/')) {
                appHistory.pop();
            }

            if (appHistory.length > 0) {
                // Go to the last view in our custom history
                const lastHash = appHistory[appHistory.length - 1];
                // We pop it here so handleHashChange can push it back, making it the new "current"
                appHistory.pop();
                window.location.hash = lastHash;
            } else {
                // If no history, go to the main view
                navigateHomeWithTrace('close-property: no-history');
            }
        }

        // List item clicks
        const li = e.target.closest('li');
        if (li) {
            // Save scroll position before navigating to a property
            if (li.dataset.id) {
                const scrollableContent = bottomSheet.querySelector('.scrollable-content');
                if (scrollableContent) {
                    const currentHash = window.location.hash || '';
                    savedScrollPositions[currentHash] = scrollableContent.scrollTop;
                }
            }

            if (li.dataset.name) window.location.hash = `#district/${encodeURIComponent(li.dataset.name)}`;
            if (li.dataset.id) attemptShowProperty(li.dataset.id);
            if (li.dataset.hash) window.location.hash = `#${li.dataset.hash}`;
            if (li.dataset.color) window.location.hash = `#survey/color/${encodeURIComponent(li.dataset.color)}`;
            if (li.dataset.decade) window.location.hash = `#survey/decade/${encodeURIComponent(li.dataset.decade)}`;
            if (li.dataset.architect) window.location.hash = `#survey/architect/${encodeURIComponent(li.dataset.architect)}`;
            if (li.dataset.style) window.location.hash = `#survey/style/${encodeURIComponent(li.dataset.style)}`;
        }
    });

    // Mirror delegated listener for the right-side panel (property details)
    if (rightSheet) {
        rightSheet.addEventListener('click', function (e) {
            // Follow map toggle (right-sheet variant)
            if (e.target.id === 'follow-map-toggle') {
                isMapFollowEnabled = !isMapFollowEnabled;
                console.debug('[DEBUG] follow-map toggled (right sheet), now:', isMapFollowEnabled);
                refreshPanel();
            }
            // Back button: prefer returning to the districts list when
            // currently viewing a district.
            if (e.target.classList.contains('back-button')) {
                const currentHash = window.location.hash || '';
                const lastNonProp = getLastNonPropertyHash();

                // Handle survey subroutes with hierarchical back navigation
                if (currentHash.startsWith('#survey/color/')) {
                    navigateToPanel('#survey/color');
                    return;
                }
                if (currentHash.startsWith('#survey/decade/')) {
                    navigateToPanel('#survey/decade');
                    return;
                }
                if (currentHash.startsWith('#survey/style/')) {
                    navigateToPanel('#survey/style');
                    return;
                }
                if (currentHash.startsWith('#survey/architect/')) {
                    navigateToPanel('#survey/architect');
                    return;
                }
                if (currentHash === '#survey/color' || currentHash === '#survey/decade' || currentHash === '#survey/style' || currentHash === '#survey/architect') {
                    navigateToPanel('#survey');
                    return;
                }

                const shouldGoToDistricts = currentHash.startsWith('#district/') || activeDistrictContext || selectedDistrictLayer || (lastNonProp && (lastNonProp === '#districts' || lastNonProp.startsWith('#district/')));
                if (shouldGoToDistricts) {
                    navigateToPanel('#districts');
                } else {
                    const lastNonProp = getLastNonPropertyHash();
                    if (lastNonProp && (lastNonProp === '#landmarks' || lastNonProp.startsWith('#survey'))) {
                        if (lastNonProp === '#landmarks') navigateToPanel('#landmarks');
                        else navigateToPanel('#survey');
                    } else {
                        navigateHomeWithTrace('back-button (rightSheet)');
                    }
                }
            }

            // Close property button: hide the right panel and navigate back.
            if (e.target.classList.contains('close-property-button')) {
                e.preventDefault();
                if (rightSheet) {
                    rightSheet.classList.remove('property-view-active');
                }
                if (rightSheetContent) {
                    // Clear images' src before removing innerHTML to help browsers free decoder resources.
                    try {
                        rightSheetContent.querySelectorAll('img').forEach(img => { try { img.src = ''; } catch (e) { } });
                    } catch (e) { }
                    rightSheetContent.innerHTML = '';
                }
                // Try to return to the last meaningful view in our appHistory
                if (appHistory.length > 0 && appHistory[appHistory.length - 1].startsWith('#property/')) {
                    appHistory.pop();
                }
                if (appHistory.length > 0) {
                    const lastHash = appHistory[appHistory.length - 1];
                    appHistory.pop();
                    window.location.hash = lastHash;
                } else {
                    navigateHomeWithTrace('rightSheet close-property: no-history');
                }
            }

            const li = e.target.closest('li');
            if (li) {
                if (li.dataset.name) window.location.hash = `#district/${encodeURIComponent(li.dataset.name)}`;
                if (li.dataset.id) attemptShowProperty(li.dataset.id);
                if (li.dataset.hash) window.location.hash = `#${li.dataset.hash}`;
                if (li.dataset.color) window.location.hash = `#survey/color/${encodeURIComponent(li.dataset.color)}`;
                if (li.dataset.decade) window.location.hash = `#survey/decade/${encodeURIComponent(li.dataset.decade)}`;
                if (li.dataset.architect) window.location.hash = `#survey/architect/${encodeURIComponent(li.dataset.architect)}`;
                if (li.dataset.style) window.location.hash = `#survey/style/${encodeURIComponent(li.dataset.style)}`;
            }
        });
    }

    // Map move listener (for "Follow map") - debounce to avoid heavy
    // repeated processing when the user pans/zooms quickly.
    map.on('moveend', () => {
        if (mapMoveTimer) { clearTimeout(mapMoveTimer); mapMoveTimer = null; }
        mapMoveTimer = setTimeout(() => {
            // Allow follow-map to refresh panels even when a property is open,
            // but NOT when we're currently viewing a property route on mobile.
            const currentHash = window.location.hash || '';
            const isOnPropertyRoute = currentHash.startsWith('#property/');

            if (isMapFollowEnabled && bottomSheet.classList.contains('expanded') && !isOnPropertyRoute) {
                refreshPanel();
            }
            mapMoveTimer = null;
        }, 200);
    });

    // Location button and map event listeners
    locationButton.addEventListener('click', handleLocationClick);
    map.on('dragstart', disableLocation);
    map.on('locationfound', handleLocationFound);
    map.on('locationerror', handleLocationError);

    // Setup mobile drag interactions
    setupMobileDrag();

    // Setup custom tooltip
    setupCustomTooltip();
}

/**
 * Sets up custom tooltip behavior
 */
function setupCustomTooltip() {
    let tooltip = document.getElementById('custom-tooltip');
    if (!tooltip) {
        tooltip = document.createElement('div');
        tooltip.id = 'custom-tooltip';
        document.body.appendChild(tooltip);
    }

    const show = (text, e) => {
        tooltip.textContent = text;
        tooltip.classList.add('visible');
        move(e);
    };

    const hide = () => {
        tooltip.classList.remove('visible');
    };

    const move = (e) => {
        const x = e.clientX;
        const y = e.clientY;
        const rect = tooltip.getBoundingClientRect();

        // Position logic to keep on screen
        let top = y + 15;
        let left = x + 15;

        // If going off right edge, flip to left
        if (left + rect.width > window.innerWidth) {
            left = x - rect.width - 10;
        }

        // *** FIX: If flipping to left makes it go off left edge, force it to 0 or center it ***
        if (left < 0) {
            left = 10; // Simple safety margin
        }

        if (top + rect.height > window.innerHeight) {
            top = y - rect.height - 10;
        }

        tooltip.style.top = `${top}px`;
        tooltip.style.left = `${left}px`;
    };

    // Expose hide globally to allow other components to force hide (e.g. on nav)
    window.hideTooltip = hide;

    // Delegation
    document.addEventListener('mouseover', (e) => {
        const target = e.target.closest('[data-tooltip]');
        if (target) {
            show(target.getAttribute('data-tooltip'), e);
        }
    });

    document.addEventListener('mouseout', (e) => {
        const target = e.target.closest('[data-tooltip]');
        if (target) {
            hide();
        }
    });

    document.addEventListener('mousemove', (e) => {
        if (tooltip.classList.contains('visible')) {
            move(e);
        }
    });

    // Mobile tap support
    document.addEventListener('click', (e) => {
        const target = e.target.closest('[data-tooltip]');
        if (target) {
            // Toggle or show?
            // On mobile, click might be the only way.
            // We can show it for a few seconds then hide.
            show(target.getAttribute('data-tooltip'), e);
            setTimeout(hide, 3000);
        } else {
            // If clicking elsewhere, hide immediately
            hide();
        }
    });
}

/**
 * Sets up touch drag behavior for the mobile bottom sheet
 */
/**
 * Sets up touch drag behavior for the mobile bottom sheet
 */
function setupMobileDrag() {
    let startY = 0;
    let currentY = 0;
    let isDragging = false;
    let startHeight = 0;
    const sheet = document.getElementById('bottom-sheet');

    // Helper to get current sheet height
    const getSheetHeight = () => sheet.offsetHeight;

    sheet.addEventListener('touchstart', (e) => {
        const touchY = e.touches[0].clientY;
        const sheetRect = sheet.getBoundingClientRect();
        const relativeY = touchY - sheetRect.top;

        // Allow drag if:
        // 1. Touching the handle
        // 2. Touching the top 60px of the sheet (header area)
        // 3. NOT touching a button or interactive element

        const isHandle = e.target.closest('.handle');
        const isHeaderArea = relativeY < 60;
        const isInteractive = e.target.closest('button') || e.target.closest('a') || e.target.closest('.highlight-toggle');

        if ((isHandle || isHeaderArea) && !isInteractive) {
            startY = e.touches[0].clientY;
            startHeight = getSheetHeight();
            isDragging = true;
            sheet.style.transition = 'none'; // Disable transition during drag
        }
    }, { passive: true });

    document.addEventListener('touchmove', (e) => {
        if (!isDragging) return;

        currentY = e.touches[0].clientY;
        let deltaY = startY - currentY; // Up is positive delta

        // Increase sensitivity for dragging down (negative delta)
        if (deltaY < 0) {
            deltaY *= 1.5;
        }

        let newHeight = startHeight + deltaY;

        // Constraints
        const minHeight = 60; // Collapsed
        const maxHeight = window.innerHeight - 160;

        if (newHeight < minHeight) newHeight = minHeight;
        if (newHeight > maxHeight) newHeight = maxHeight;

        sheet.style.height = `${newHeight}px`;

    }, { passive: false });

    document.addEventListener('touchend', (e) => {
        if (!isDragging) return;
        isDragging = false;
        sheet.style.transition = 'transform 0.3s cubic-bezier(0.25, 0.46, 0.45, 0.94), height 0.3s cubic-bezier(0.25, 0.46, 0.45, 0.94)';

        const currentHeight = getSheetHeight();
        const windowHeight = window.innerHeight;

        // Snap logic
        let targetState = 'half';

        if (currentHeight < 200) {
            targetState = 'collapsed';
        } else if (currentHeight > windowHeight * 0.6) {
            targetState = 'full';
        } else {
            targetState = 'half';
        }

        // Apply state
        if (targetState === 'collapsed') {
            sheet.style.height = '';
            sheet.classList.remove('expanded');
            toggleBottomSheet(false);
        } else if (targetState === 'full') {
            const maxHeight = window.innerHeight - 160;
            sheet.style.height = `${maxHeight}px`;
            sheet.classList.add('expanded');
        } else {
            // Half
            sheet.style.height = '45vh';
            sheet.classList.add('expanded');
        }
    });

    // Click handling for toggle is still useful
    bottomSheet.addEventListener('click', (e) => {
        const header = e.target.closest('.sheet-header');
        const isInteractive = e.target.closest('button') || e.target.closest('a') || e.target.closest('.highlight-toggle');

        if (header && !isInteractive) {
            toggleBottomSheet();
        }
    });
}

// ---------------------------------------------------------------
//  3. ROUTER - Reads the URL hash and controls the app
// ---------------------------------------------------------------

function handleHashChange() {
    if (!isDataLoaded) return;

    const hash = window.location.hash;

    // Update lastListHash if this is a list view (not a property view)
    // This allows the "Close" button on mobile to return to the last context.
    if (hash && !hash.startsWith('#property/') && hash !== '#') {
        lastListHash = hash;
    }

    // Push to our custom history tracker, avoiding duplicates.
    if (appHistory.length === 0 || appHistory[appHistory.length - 1] !== hash) {
        appHistory.push(hash);
        // Cap history to avoid unbounded growth which can cause memory pressure
        if (appHistory.length > 300) {
            appHistory.shift();
        }

        // Track route change in Google Analytics
        let pagePath = hash || '/';
        let pageTitle = hash || 'Home';

        // Sanitize search hashes to remove PII (search terms)
        if (pagePath.startsWith('#search/')) {
            pagePath = '#search';
            pageTitle = 'Search Results';
        }

        trackEvent('page_view', {
            page_path: pagePath,
            page_title: pageTitle
        });
    }

    // Determine previous hash (if any) so we can preserve district context
    const prevHash = (appHistory.length >= 2) ? appHistory[appHistory.length - 2] : null;

    // If the current target is a property, try to determine which district
    // (if any) contains it. This helps when navigating property->property
    // so we can keep the district highlighted even if the direct previous
    // hash isn't the district page.
    let currentPropertyDistrict = null;
    if (window.location.hash && window.location.hash.startsWith('#property/')) {
        try {
            const bldgId = parseInt(window.location.hash.split('/')[1], 10);
            currentPropertyDistrict = findDistrictNameForProperty(bldgId);
        } catch (e) { currentPropertyDistrict = null; }
    }

    // Clear building highlights and search dropdown always.
    clearBuildingHighlight();
    clearSearchDropdown();

    // Ensure tooltips are hidden on navigation
    if (window.hideTooltip) window.hideTooltip();

    // Decide whether to preserve the selected district highlight.
    // Keep the district visible when:
    // - we're on a district detail (#district/...), or
    // - we're on a property and `activeDistrictContext` is set (opened from a district),
    // - or we're transitioning directly from a district to a property.
    const transitioningDistrictToProperty = prevHash && prevHash.startsWith('#district/') && hash && hash.startsWith('#property/');
    // Preserve when explicitly on a district page, or when on a property and
    // we already have an active district context, or when transitioning
    // district->property. Additionally, preserve if the current property
    // is inside a district that matches either the active context or the
    // previous hash (useful when moving property->property).
    let shouldPreserveDistrict = (hash && hash.startsWith('#district/'))
        || (hash && hash.startsWith('#property/') && activeDistrictContext)
        || transitioningDistrictToProperty;

    if (!shouldPreserveDistrict && currentPropertyDistrict) {
        // If previous hash references the district page for this property,
        // or the previous property belonged to the same district, preserve.
        if (prevHash && prevHash.startsWith('#district/')) {
            const prevDistrictName = decodeURIComponent(prevHash.split('/')[1] || '');
            if (prevDistrictName === currentPropertyDistrict) shouldPreserveDistrict = true;
        } else if (prevHash && prevHash.startsWith('#property/')) {
            try {
                const prevBldgId = parseInt(prevHash.split('/')[1], 10);
                const prevDistrict = findDistrictNameForProperty(prevBldgId);
                if (prevDistrict && prevDistrict === currentPropertyDistrict) shouldPreserveDistrict = true;
            } catch (e) { }
        }
        // Also if activeDistrictContext matches the property district
        if (activeDistrictContext && activeDistrictContext === currentPropertyDistrict) shouldPreserveDistrict = true;
        // If we decided to preserve, ensure the active context is set.
        if (shouldPreserveDistrict) {
            activeDistrictContext = currentPropertyDistrict;
        }
    }

    // Preserve boundaries when viewing a property from the top-level districts panel
    // Set a special activeDistrictContext so subsequent property selections
    // continue showing all district boundaries until the user changes the
    // left-panel view/state.
    if (!shouldPreserveDistrict) {
        // *** FIX: Also preserve if coming from home (#) or empty hash ***
        const isFromHome = !prevHash || prevHash === '#' || prevHash === '';
        if ((prevHash === '#districts' || isFromHome) && hash.startsWith('#property/')) {
            // Keep all district boundaries visible and record special context
            showDistrictsLayer();
            activeDistrictContext = '__ALL_DISTRICTS__';
        } else {
            clearDistrictHighlight();
            activeDistrictContext = null;
        }
    }

    // *** FIX: Always remove property view class on nav and clear right-sheet content ***
    if (bottomSheet) {
        bottomSheet.classList.remove('property-view-active');
    }

    // Check if we should preserve the right panel (e.g. when clicking an architect link from a property)
    // This allows the user to see the filtered list on the left while keeping the property details on the right.
    const preserveRightPanel = (hash.startsWith('#survey/architect/') && prevHash && prevHash.startsWith('#property/'));

    if (rightSheet && !preserveRightPanel) {
        rightSheet.classList.remove('property-view-active');
        if (rightSheetContent) {
            try {
                rightSheetContent.querySelectorAll('img').forEach(img => { try { img.src = ''; } catch (e) { } });
            } catch (e) { }
            rightSheetContent.innerHTML = '';
        }
    }

    if (hash.startsWith('#property/')) {
        const bldgId = parseInt(hash.split('/')[1], 10);
        const feature = surveyData.features.find(f => f.properties.BLDG_ID === bldgId);
        if (feature) {
            // If we came from a district, keep that district context active
            if (prevHash && prevHash.startsWith('#district/')) {
                const prevDistrictName = decodeURIComponent(prevHash.split('/')[1]);
                activeDistrictContext = prevDistrictName;
                // Ensure the survey layer remains filtered to that district
                try { updateSurveyLayer('district', activeDistrictContext); } catch (e) { }
                // Re-highlight the district if necessary
                const prevDistrictFeature = allDistricts.find(d => d.properties.NAME === activeDistrictContext);
                if (prevDistrictFeature && !selectedDistrictLayer) {
                    highlightDistrict(prevDistrictFeature);
                }
            } else if (activeDistrictContext === '__ALL_DISTRICTS__') {
                // Preserve the special marker indicating all district boundaries
                // should remain visible across subsequent property selections.
            } else {
                activeDistrictContext = null;
            }

            highlightBuilding(feature);
            buildPropertyCard(feature.properties);
            zoomToFeature(feature, 18, { offsetScale: 1.3 });
        }
        // Only hide the main district layers if there's no active district context
        // Special case: if previous hash was #districts, keep all boundaries visible
        if (!activeDistrictContext) {
            if (prevHash === '#districts') {
                showDistrictsLayer();
            } else {
                hideDistrictsLayer();
            }
        }

    } else if (hash.startsWith('#district/')) {
        const districtName = decodeURIComponent(hash.split('/')[1]);
        const feature = allDistricts.find(f => f.properties.NAME === districtName);
        if (feature) {
            // Mark the app as locked to this district so we keep showing
            // its boundary and only properties inside it until the user
            // navigates away via back/nav.
            activeDistrictContext = districtName;
            highlightDistrict(feature);
            buildDistrictDetailsPanel(feature);
            zoomToFeature(feature);
            // While in a district detail view, limit the survey layer to
            // properties that belong to this district so the map shows only
            // relevant houses.
            try {
                updateSurveyLayer('district', districtName);
            } catch (e) {
                console.warn('Could not filter survey layer for district:', districtName, e);
            }
        }
    } else if (hash.startsWith('#search/')) {
        const query = decodeURIComponent(hash.split('/')[1]);
        if (searchInput.value !== query) {
            smartSetView([41.71, -87.67], 13);
            console.debug('[DEBUG] search branch: disabling follow-map due to programmatic search navigation');
            isMapFollowEnabled = false;
        }
        searchInput.value = query;
        handleSearch(query);
        updateActivePill(null);
        hideDistrictsLayer();

    } else if (hash === '#landmarks') {
        buildLandmarksPanel();
        updateActivePill('landmarks');
        hideDistrictsLayer();
        try { smartSetView([41.71, -87.67], 13); } catch (e) { }

    } else if (hash === '#districts') {
        clearHighlight();
        console.debug('[DEBUG] handleHashChange: entering #districts — scheduling UI update');
        updateActivePill('districts');
        // Defer heavy UI/layer updates briefly so the browser can finish
        // processing the click event and render the panel before we do
        // potentially expensive layer operations which can cause jank.
        setTimeout(() => {
            try {
                buildDistrictsPanel();
                showDistrictsLayer();
                setDistrictLayerOpacity(0.6);
                // Filter survey layer to only properties inside historic districts
                const allDistrictIds = new Set();
                Object.values(districtFeatureMap).forEach(arr => arr.forEach(f => allDistrictIds.add(f.properties.BLDG_ID)));
                updateSurveyLayer('districts-filter', allDistrictIds);
            } catch (e) {
                console.warn('Error while initializing districts view', e);
            }
        }, 40);
        // Do not force a setView when entering districts — avoid snapping
        // the map while the user is panning or when follow-map is toggled.

    } else if (hash.startsWith('#survey')) {
        hideDistrictsLayer();
        updateActivePill('survey');

        if (hash === '#survey') {
            buildSurveyPanel();
            updateSurveyLayer('default');
            try { smartSetView([41.71, -87.675], 15); } catch (e) { }
        } else if (hash === '#survey/color') {
            buildColorCodeListPanel();
            updateSurveyLayer('color');
        } else if (hash.startsWith('#survey/color/')) {
            const color = decodeURIComponent(hash.split('/')[2]);
            buildColorCodeDetailPanel(color);
            updateSurveyLayer('color', color);
        } else if (hash === '#survey/decade') {
            buildDecadeListPanel();
            updateSurveyLayer('decade');
        } else if (hash.startsWith('#survey/decade/')) {
            const decade = decodeURIComponent(hash.split('/')[2]);
            buildDecadeDetailPanel(decade);
            updateSurveyLayer('decade', decade);
        } else if (hash === '#survey/architect') {
            buildArchitectListPanel();
            updateSurveyLayer('architect');
        } else if (hash.startsWith('#survey/architect/')) {
            const architect = decodeURIComponent(hash.split('/')[2]);
            buildArchitectDetailPanel(architect);
            updateSurveyLayer('architect', architect);
        } else if (hash === '#survey/style') {
            buildStyleListPanel();
            updateSurveyLayer('style');
        } else if (hash.startsWith('#survey/style/')) {
            const style = decodeURIComponent(hash.split('/')[2]);
            buildStyleDetailPanel(style);
            updateSurveyLayer('style', style);
        }
    } else {
        // Default "home" state
        showDefaultPanel();
        updateActivePill('');
        updateSurveyLayer('default');
        showDistrictsLayer();
        setDistrictLayerOpacity(0.6);
        // Ensure the default center respects the right-panel offset
        try { smartSetView([41.71, -87.67], 13); } catch (e) { /* swallow */ }
        // *** FIX: Correctly toggle panel based on screen size ***
        if (window.innerWidth < 768) {
            toggleBottomSheet(true); // Show mobile panel at middle position
        } else {
            toggleBottomSheet(true); // Ensure desktop panel is open
        }
    }
}

/**
 * Lightweight refresh of the currently visible panel content without
 * changing map view or clearing highlights. Used by follow-map so we
 * can update lists based on the current visible map area without
 * causing re-centers or heavy router side-effects.
 */
function refreshPanel() {
    if (!isDataLoaded) return;
    // If we're currently viewing a single property, find the last
    // non-property view in our `appHistory` so we can refresh the
    // underlying list/panel (left/bottom sheet) while the right panel
    // shows the property. This keeps "Follow map" behavior active for
    // lists even when an item is open.
    let hash = window.location.hash || '';
    if (hash.startsWith('#property/')) {
        // Walk history backwards (excluding the current property hash)
        let lastNonProperty = null;
        for (let i = appHistory.length - 2; i >= 0; i--) {
            const h = appHistory[i] || '';
            if (!h.startsWith('#property/')) { lastNonProperty = h; break; }
        }
        if (lastNonProperty) {
            console.debug('[DEBUG] refreshPanel: using last non-property hash from history ->', lastNonProperty);
            hash = lastNonProperty;
        } else {
            // Fallback to home if none found
            console.debug('[DEBUG] refreshPanel: no last non-property hash found, falling back to home');
            hash = '#';
        }
    }

    try {
        if (hash.startsWith('#district/')) {
            const districtName = decodeURIComponent(hash.split('/')[1]);
            const feature = allDistricts.find(f => f.properties && (f.properties.NAME === districtName || f.properties.name === districtName));
            if (feature) {
                // Rebuild district panel and ensure survey layer filtered
                buildDistrictDetailsPanel(feature);
                try { updateSurveyLayer('district', districtName); } catch (e) { }
            }
            return;
        }

        if (hash === '#districts') {
            console.debug('[DEBUG] refreshPanel: scheduling districts panel rebuild');
            setTimeout(() => {
                try {
                    buildDistrictsPanel();
                    showDistrictsLayer();
                    setDistrictLayerOpacity(0.6);
                    updateSurveyLayer('default');
                } catch (e) { console.debug('refreshPanel districts rebuild error', e); }
            }, 40);
            return;
        }

        if (hash === '#landmarks') {
            buildLandmarksPanel();
            hideDistrictsLayer();
            return;
        }

        if (hash.startsWith('#survey')) {
            // Delegate to the same builders used by the router but avoid map changes
            if (hash === '#survey') {
                buildSurveyPanel(); updateSurveyLayer('default');
            } else if (hash === '#survey/color') {
                buildColorCodeListPanel(); updateSurveyLayer('color');
            } else if (hash.startsWith('#survey/color/')) {
                const color = decodeURIComponent(hash.split('/')[2]);
                buildColorCodeDetailPanel(color); updateSurveyLayer('color', color);
            } else if (hash === '#survey/decade') {
                buildDecadeListPanel(); updateSurveyLayer('decade');
            } else if (hash.startsWith('#survey/decade/')) {
                const decade = decodeURIComponent(hash.split('/')[2]);
                buildDecadeDetailPanel(decade); updateSurveyLayer('decade', decade);
            } else if (hash === '#survey/architect') {
                buildArchitectListPanel(); updateSurveyLayer('architect');
            } else if (hash.startsWith('#survey/architect/')) {
                const architect = decodeURIComponent(hash.split('/')[2]);
                buildArchitectDetailPanel(architect); updateSurveyLayer('architect', architect);
            } else if (hash === '#survey/style') {
                buildStyleListPanel(); updateSurveyLayer('style');
            } else if (hash.startsWith('#survey/style/')) {
                const style = decodeURIComponent(hash.split('/')[2]);
                buildStyleDetailPanel(style); updateSurveyLayer('style', style);
            }
            return;
        }

        // Default/home: just rebuild default panel and survey layer
        showDefaultPanel(); updateSurveyLayer('default'); showDistrictsLayer(); setDistrictLayerOpacity(0.6);
    } catch (e) {
        console.debug('refreshPanel error', e);
    }
}

// ---------------------------------------------------------------
//  4. PANEL-BUILDING FUNCTIONS
// ---------------------------------------------------------------

// --- MAIN LISTS ---

function buildDistrictsPanel() {
    // Helper to filter by bounds if needed
    const filterByBounds = (features) => {
        if (!isMapFollowEnabled) return features;
        const mapBounds = getVisibleMapBounds();
        return features.filter(feature => {
            try { return L.geoJSON(feature).getBounds().intersects(mapBounds); }
            catch (e) { return false; }
        });
    };

    // Get features from globals
    let nationalFeatures = nationalDistricts ? nationalDistricts.features : [];
    let chicagoFeatures = chicagoDistricts ? chicagoDistricts.features : [];

    // Filter
    nationalFeatures = filterByBounds(nationalFeatures);
    chicagoFeatures = filterByBounds(chicagoFeatures);

    // Sort
    nationalFeatures.sort((a, b) => a.properties.NAME.localeCompare(b.properties.NAME));
    chicagoFeatures.sort((a, b) => a.properties.NAME.localeCompare(b.properties.NAME));

    // Helper to build list HTML
    const buildList = (features) => features.map(f => {
        const name = f.properties.NAME;
        const color = getDistrictColor(name);
        return `
            <li data-name="${name}">
                <a>
                    <span class="color-swatch" style="background-color: ${color}"></span>
                    ${name}
                </a>
            </li>`;
    }).join('');

    const nationalHtml = buildList(nationalFeatures);
    const chicagoHtml = buildList(chicagoFeatures);

    const followToggleHtml = `<button id="follow-map-toggle" class="pill ${isMapFollowEnabled ? 'active' : ''}">Follow map</button>`;

    sheetContent.innerHTML = `
        <div class="sheet-header">
            <h3><button class="back-button">&larr;</button>Historic Districts</h3>
            ${followToggleHtml}
        </div>
        <div class="scrollable-content">
            ${chicagoHtml ? `<h4 style="padding: 15px 15px 5px; margin: 0; color: #666; font-size: 0.85em; text-transform: uppercase; letter-spacing: 0.5px; font-weight: 700;">Chicago Landmark Districts</h4><ul class="item-list">${chicagoHtml}</ul>` : ''}
            ${nationalHtml ? `<h4 style="padding: 15px 15px 5px; margin: 0; color: #666; font-size: 0.85em; text-transform: uppercase; letter-spacing: 0.5px; font-weight: 700;">National Register Districts</h4><ul class="item-list">${nationalHtml}</ul>` : ''}
            ${(!chicagoHtml && !nationalHtml) ? '<p style="padding: 20px; text-align: center; color: #666;">No districts found in this view.</p>' : ''}
            <div class="mobile-footer" style="padding: 15px 0 0 0; color: #666; font-size: 0.9em; line-height: 1.5; border-top: 1px solid #eee; margin-top: 15px;">
                Browse designated historic districts. Chicago Landmark District areas are subject to additional permit requirements and approvals for alterations. Financial incentives for preservation are available in some cases.
            </div>
        </div>
        <div class="desktop-footer" style="padding: 15px 20px; color: #666; font-size: 0.9em; line-height: 1.5; border-top: 1px solid #eee; background-color: #f9f9f9;">
            Browse designated historic districts. Chicago Landmark District areas are subject to additional permit requirements and approvals for alterations. Financial incentives for preservation are available in some cases.
        </div>
    `;
    toggleBottomSheet(true);
}

function buildLandmarksPanel() {
    // 1. Chicago Landmarks
    const allLandmarks = surveyData.features.filter(f => {
        const value = f.properties.individual_landmark;
        return value && (String(value).trim().toUpperCase() === 'Y' || String(value).trim().toUpperCase() === 'YES');
    });

    // 2. Contributing Properties to Ridge Historic District
    const contributingRidge = surveyData.features.filter(f => {
        const value = f.properties.contributing_ridge_historic_district;
        return value && (String(value).trim().toUpperCase() === 'Y' || String(value).trim().toUpperCase() === 'YES');
    });

    let filteredLandmarks = allLandmarks;
    let filteredContributing = contributingRidge;

    if (isMapFollowEnabled) {
        const featuresInView = getFeaturesInView();
        const inViewIds = new Set(featuresInView.map(f => f.properties.BLDG_ID));
        filteredLandmarks = allLandmarks.filter(f => inViewIds.has(f.properties.BLDG_ID));
        filteredContributing = contributingRidge.filter(f => inViewIds.has(f.properties.BLDG_ID));
    }

    filteredLandmarks.sort(propertySort);
    filteredContributing.sort(propertySort);

    // Update global navigation list
    // Combine both lists in the order they appear in the UI
    currentNavigationList = [...filteredLandmarks, ...filteredContributing];

    // Helper to generate list HTML
    const generateList = (items) => {
        if (items.length === 0) return '<p style="padding: 0 20px; color: #666; font-style: italic;">No properties found in this view.</p>';
        return `<ul class="item-list">${items.map(f => `<li data-id="${f.properties.BLDG_ID}"><a>${formatListItem(f.properties)}</a></li>`).join('')}</ul>`;
    };

    // Helper for highlight button
    const renderHighlightBtn = (key, label, isActive = false) => {
        // Use CSS for active state (opacity/filter) via .highlight-active class
        return `<button class="highlight-toggle ${isActive ? 'highlight-active' : ''}" data-highlight-key="${key}" title="Highlight ${label} on map" style="margin-left: 10px; background: none; border: none; cursor: pointer; padding: 4px;">
            <img src="marker-tool-svgrepo-com.svg" class="highlight-icon" />
        </button>`;
    };

    // Cache highlight targets
    highlightFeatureCache['landmarks_chicago'] = allLandmarks;
    highlightFeatureCache['landmarks_contributing'] = contributingRidge;

    const followToggleHtml = `<button id="follow-map-toggle" class="pill ${isMapFollowEnabled ? 'active' : ''}">Follow map</button>`;

    sheetContent.innerHTML = `
        <div class="sheet-header">
            <h3><button class="back-button">&larr;</button>Individual Landmarks</h3>
            ${followToggleHtml}
        </div>
        <div class="scrollable-content">
            
            <!-- Chicago Landmarks Section -->
            <div class="property-section-header" style="padding: 15px 10px 5px 10px; display: flex; align-items: center; justify-content: space-between;">
                <h4 style="margin: 0; padding: 0; color: #666; text-transform: uppercase; font-size: 0.9em; letter-spacing: 0.5px;">Chicago Landmarks (${filteredLandmarks.length})</h4>
                ${renderHighlightBtn('landmarks_chicago', 'Chicago Landmarks', true)}
            </div>
            ${generateList(filteredLandmarks)}

            <!-- Contributing Properties Section -->
            <div class="property-section-header" style="padding: 25px 10px 5px 10px; display: flex; align-items: center; justify-content: space-between;">
                <h4 style="margin: 0; padding: 0; color: #666; text-transform: uppercase; font-size: 0.9em; letter-spacing: 0.5px;">Contributing Properties to<br>Ridge Historic District (${filteredContributing.length})</h4>
                ${renderHighlightBtn('landmarks_contributing', 'Contributing Properties', false)}
            </div>
            ${generateList(filteredContributing)}

            <div class="mobile-footer" style="padding: 15px 20px; color: #666; font-size: 0.9em; line-height: 1.5; border-top: 1px solid #eee; margin-top: 15px;">
                View individual properties designated as Chicago Landmarks and contributing properties to the Ridge Historic District.
            </div>
        </div>
        <div class="desktop-footer" style="padding: 15px 20px; color: #666; font-size: 0.9em; line-height: 1.5; border-top: 1px solid #eee; background-color: #f9f9f9;">
            View individual properties designated as Chicago Landmarks and contributing properties to the Ridge Historic District.
        </div>
    `;
    toggleBottomSheet(true);
    restoreScrollPosition();

    // Default highlight: Show both Chicago Landmarks AND Contributing Properties
    try { updateSurveyLayer('landmarks'); } catch (e) { console.debug('updateSurveyLayer(landmarks) failed', e); }

    // Set highlight ONLY for Chicago Landmarks by default
    // And ensure the button state is correctly linked
    const chicagoBtn = sheetContent.querySelector('button[data-highlight-key="landmarks_chicago"]');
    setHighlight(allLandmarks, 'landmarks_chicago', chicagoBtn);

    // We need to manually set the button state because setHighlight resets it
    // But wait, setHighlight takes a controlButton argument.
    // We don't have the DOM element yet because we just set innerHTML.
    // So we rely on the 'active' class in the HTML we just generated.
    // However, setHighlight calls resetHighlightButtonState which might clear something?
    // resetHighlightButtonState clears highlightControlButton.
    // Since we haven't set highlightControlButton yet, it's fine.
    // But we need to make sure subsequent clicks work.
    // When user clicks, handleHighlightToggle will find the button and pass it to setHighlight.
    // For the initial state, we just want the visual 'active' class (which we added in HTML)
    // and the map circles (which setHighlight does).
    // We also need to set highlightOrigin so toggle works.
    // setHighlight sets highlightOrigin.
}

/**
 * Main search handler
 */
function handleSearch(query) {
    if (!query || query.length < 3) {
        sheetContent.innerHTML = `
            <div class="sheet-header"><h3>Search</h3></div>
            <div class="scrollable-content"><p>Please enter at least 3 characters.</p></div>
        `;
        toggleBottomSheet(true);
        return;
    }
    const searchQuery = query.toLowerCase().trim();

    const results = surveyData.features.filter(f => {
        const address = formatAddress(f.properties).toLowerCase();
        return address.includes(searchQuery);
    });

    if (results.length === 1) {
        // Single result: attempt to show (respect current filters/view)
        const feature = results[0];
        attemptShowProperty(feature.properties.BLDG_ID);
    } else {
        buildSearchPanel(query, results);
    }
}

/**
 * Builds the Search Results panel
 */
function buildSearchPanel(query, results) {
    let filteredResults = results;
    if (isMapFollowEnabled) {
        const featuresInView = getFeaturesInView();
        const inViewIds = new Set(featuresInView.map(f => f.properties.BLDG_ID));
        filteredResults = results.filter(f => inViewIds.has(f.properties.BLDG_ID));
    }

    filteredResults.sort(propertySort);

    // Update global navigation list
    currentNavigationList = filteredResults;

    // Track search in Google Analytics
    // Track search in Google Analytics
    trackEvent('search', {
        // search_term removed for privacy
        results_count: filteredResults.length
    });

    let listHtml = filteredResults.length === 0 ? '<p>No matching properties found.</p>' :
        `<ul class="item-list">${filteredResults.map(f => `<li data-id="${f.properties.BLDG_ID}"><a>${formatListItem(f.properties)}</a></li>`).join('')}</ul>`;

    const followToggleHtml = `<button id="follow-map-toggle" class="pill ${isMapFollowEnabled ? 'active' : ''}">Follow map</button>`;
    sheetContent.innerHTML = `
        <div class="sheet-header">
            <h3>Search Results (${filteredResults.length})</h3>
            ${followToggleHtml}
        </div>
        <div class="scrollable-content">${listHtml}</div>
    `;

    toggleBottomSheet(true);
    restoreScrollPosition();
}

// --- SURVEY SUB-PANELS ---

function buildSurveyPanel() {
    clearHighlight();
    sheetContent.innerHTML = `
        <div class="sheet-header"><h3><button class="back-button">&larr;</button>Surveys</h3></div>
        <div class="scrollable-content">
            <h4 style="padding: 15px 10px 5px 10px; margin: 0; color: #666; text-transform: uppercase; font-size: 0.9em; letter-spacing: 0.5px;">Chicago Historic Resources Survey</h4>
            <ul class="item-list">
                <li data-hash="survey/color"><a>Color Code</a></li>
                <li data-hash="survey/decade"><a>Decade Built</a></li>
                <li data-hash="survey/architect"><a>Architect</a></li>
                <li data-hash="survey/style"><a>Building Style</a></li>
            </ul>
            <div class="mobile-footer" style="padding: 15px 0 0 0; color: #666; font-size: 0.9em; line-height: 1.5; border-top: 1px solid #eee; margin-top: 15px;">
                Explore data from the <strong>Chicago Historic Resources Survey (CHRS)</strong>, a 1996 inventory of historically and architecturally significant structures.
            </div>
        </div>
        <div class="desktop-footer" style="padding: 15px 20px; color: #666; font-size: 0.9em; line-height: 1.5; border-top: 1px solid #eee; background-color: #f9f9f9;">
            Explore data from the <strong>Chicago Historic Resources Survey (CHRS)</strong>, a 1996 inventory of historically and architecturally significant structures.
        </div>
    `;
    toggleBottomSheet(true);
}

function buildColorCodeListPanel() {
    clearHighlight();
    highlightFeatureCache = {};
    const features = isMapFollowEnabled ? getFeaturesInView() : surveyData.features;
    const colorGroups = {};
    features.forEach(f => {
        const color = f.properties.CHRS_Color;
        if (!color) return;
        if (!colorGroups[color]) colorGroups[color] = [];
        colorGroups[color].push(f);
    });

    // Specified color order
    const colorOrder = ["Red", "Orange", "Yellow", "Yellow/Green", "Green", "Purple", "Blue"];
    const colorKeys = colorOrder.filter(color => colorGroups[color]);

    // Color hex codes and descriptions
    const colorConfig = {
        "Red": {
            hex: "#FF0000",
            desc: "Significant in the broader context of the City of Chicago, the State of Illinois, or the United States of America."
        },
        "Orange": {
            hex: "#FFA500",
            desc: "Significant in the context of the surrounding community."
        },
        "Yellow": {
            hex: "#FFFF00",
            desc: "Relatively unaltered, pre-1940s, part of a concentration of significant buildings."
        },
        "Yellow/Green": {
            hex: "#ADFF2F",
            desc: "Pre-1940s whose exteriors were covered with artificial siding, part of a concentration of significant buildings."
        },
        "Green": {
            hex: "#008000",
            desc: "Pre-1940s whose exteriors have been slightly altered."
        },
        "Purple": {
            hex: "#800080",
            desc: "Pre-1940s whose exteriors have been extensively altered."
        },
        "Blue": {
            hex: "#0000FF",
            desc: "Constructed after 1940. Too recent to be properly evaluated for significance and were generally not included in the CHRS database."
        }
    };

    let listHtml;
    if (colorKeys.length === 0) {
        listHtml = '<p>No color codes available.</p>';
    } else {
        listHtml = `<ul class="item-list">${colorKeys.map(color => {
            const highlightKey = `survey/color:${color}`;
            highlightFeatureCache[highlightKey] = colorGroups[color];
            const config = colorConfig[color] || { hex: color.toLowerCase(), desc: "" };
            return `<li class="filter-list-item" data-color="${color}">
                        <span class="filter-item-text">
                            <span class="color-swatch" style="background-color: ${config.hex}"></span>
                            <div>
                                <div>${color} (${colorGroups[color].length})</div>
                                <div style="font-size: 0.8em; color: #666; margin-top: 2px;">${config.desc}</div>
                            </div>
                        </span>
                        ${renderHighlightButton(highlightKey, color)}
                    </li>`;
        }).join('')}</ul>`;
    }

    const followToggleHtml = `<button id="follow-map-toggle" class="pill ${isMapFollowEnabled ? 'active' : ''}">Follow map</button>`;
    sheetContent.innerHTML = `
        <div class="sheet-header">
            <h3><button class="back-button">&larr;</button>Color Code</h3>
            ${followToggleHtml}
        </div>
        <div class="scrollable-content">${listHtml}</div>
    `;
    toggleBottomSheet(true);
}

function buildDecadeListPanel() {
    clearHighlight();
    highlightFeatureCache = {};
    const features = isMapFollowEnabled ? getFeaturesInView() : surveyData.features;
    const decadeGroups = {};
    features.forEach(f => {
        const decade = f.properties.decade; // Relies on preprocess
        if (!decade) return;
        if (!decadeGroups[decade]) decadeGroups[decade] = [];
        decadeGroups[decade].push(f);
    });

    const decadeKeys = Object.keys(decadeGroups).sort();
    let listHtml;
    if (decadeKeys.length === 0) {
        listHtml = '<p>No decade data available.</p>';
    } else {
        listHtml = `<ul class="item-list">${decadeKeys.map(decade => {
            const color = getDecadeColor(decade);
            const highlightKey = `survey/decade:${decade}`;
            highlightFeatureCache[highlightKey] = decadeGroups[decade];

            // Aggregate styles for this decade
            const styles = new Set();
            decadeGroups[decade].forEach(f => {
                const s = f.properties['CHRS_Building Style'];
                if (s) styles.add(s);
            });
            const styleList = Array.from(styles).sort().join(', ');

            return `<li class="filter-list-item" data-decade="${decade}">
                        <span class="filter-item-text">
                            <span class="color-swatch" style="background-color: ${color}"></span>
                            <div>
                                <div>${decade} (${decadeGroups[decade].length})</div>
                            </div>
                        </span>
                        ${renderHighlightButton(highlightKey, decade)}
                    </li>`;
        }).join('')}</ul>`;
    }

    const followToggleHtml = `<button id="follow-map-toggle" class="pill ${isMapFollowEnabled ? 'active' : ''}">Follow map</button>`;
    sheetContent.innerHTML = `
        <div class="sheet-header">
            <h3><button class="back-button">&larr;</button>Decade Built</h3>
            ${followToggleHtml}
        </div>
        <div class="scrollable-content">${listHtml}</div>
    `;
    toggleBottomSheet(true);
}

function buildArchitectListPanel() {
    clearHighlight();
    highlightFeatureCache = {};
    const features = isMapFollowEnabled ? getFeaturesInView() : surveyData.features;
    const architectGroups = {};
    features.forEach(f => {
        const architect = f.properties.CHRS_Architect;
        if (!architect) return;
        if (!architectGroups[architect]) architectGroups[architect] = [];
        architectGroups[architect].push(f);
    });

    const architectKeys = Object.keys(architectGroups).sort();

    // Group architects by first letter of last name
    const byLetter = {};
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

    architectKeys.forEach(architect => {
        // Extract last name (assume format: "LAST, FIRST" or "LAST NAME")
        const lastNameMatch = architect.match(/^([A-Z]+)/);
        const firstLetter = lastNameMatch ? lastNameMatch[1][0].toUpperCase() : '#';
        if (!byLetter[firstLetter]) byLetter[firstLetter] = [];
        byLetter[firstLetter].push(architect);
    });

    // Build alphabet navigation
    const alphabetHtml = `
        <div style="display: flex; flex-wrap: wrap; gap: 4px; padding: 10px 15px; border-bottom: 1px solid #eee; background: #fff;">
            ${alphabet.map(letter => {
        const hasArchitects = byLetter[letter] && byLetter[letter].length > 0;
        return `<button class="letter-nav-btn" data-letter="${letter}" style="
                    padding: 4px 8px; 
                    border: 1px solid ${hasArchitects ? '#4285F4' : '#ddd'}; 
                    background: ${hasArchitects ? '#fff' : '#f5f5f5'}; 
                    color: ${hasArchitects ? '#4285F4' : '#999'};
                    border-radius: 4px;
                    cursor: ${hasArchitects ? 'pointer' : 'default'};
                    font-size: 0.85em;
                    font-weight: ${hasArchitects ? '600' : '400'};
                    ${hasArchitects ? '' : 'opacity: 0.5;'}
                ">${letter}</button>`;
    }).join('')}
        </div>
    `;

    let listHtml;
    if (architectKeys.length === 0) {
        listHtml = '<p>No architect data available.</p>';
    } else {
        // Build list grouped by letter with anchors
        const groupedHtml = alphabet.filter(letter => byLetter[letter]).map(letter => {
            const architects = byLetter[letter];
            const itemsHtml = architects.map(architect => {
                const color = stringToColor(architect);
                const highlightKey = `survey/architect:${architect}`;
                highlightFeatureCache[highlightKey] = architectGroups[architect];
                return `<li class="filter-list-item" data-architect="${architect}">
                            <span class="filter-item-text">
                                <span class="color-swatch" style="background-color: ${color}"></span>
                                ${architect} (${architectGroups[architect].length})
                            </span>
                            ${renderHighlightButton(highlightKey, architect)}
                        </li>`;
            }).join('');

            return `
                <div id="letter-${letter}" style="scroll-margin-top: 60px;">
                    <h4 style="padding: 10px 15px; margin: 15px 0 5px; background: #f0f0f0; color: #666; font-size: 0.9em; font-weight: 700;">${letter}</h4>
                    <ul class="item-list" style="margin-top: 0;">${itemsHtml}</ul>
                </div>
            `;
        }).join('');

        listHtml = groupedHtml;
    }

    const followToggleHtml = `<button id="follow-map-toggle" class="pill ${isMapFollowEnabled ? 'active' : ''}">Follow map</button>`;
    sheetContent.innerHTML = `
        <div class="sheet-header">
            <h3><button class="back-button">&larr;</button>Architect</h3>
            ${followToggleHtml}
        </div>
        ${alphabetHtml}
        <div class="scrollable-content">${listHtml}</div>
    `;

    // Add click handlers for letter navigation
    sheetContent.querySelectorAll('.letter-nav-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const letter = e.target.dataset.letter;
            const target = document.getElementById(`letter-${letter}`);
            if (target) {
                const scrollContainer = sheetContent.querySelector('.scrollable-content');
                if (scrollContainer) {
                    scrollContainer.scrollTo({
                        top: target.offsetTop - scrollContainer.offsetTop,
                        behavior: 'smooth'
                    });
                }
            }
        });
    });

    toggleBottomSheet(true);
}

function buildStyleListPanel() {
    clearHighlight();
    highlightFeatureCache = {};
    const features = isMapFollowEnabled ? getFeaturesInView() : surveyData.features;
    const styleGroups = {};
    features.forEach(f => {
        const style = f.properties["CHRS_Building Style"];
        if (!style) return;
        if (!styleGroups[style]) styleGroups[style] = [];
        styleGroups[style].push(f);
    });

    const styleKeys = Object.keys(styleGroups).sort();
    let listHtml;
    if (styleKeys.length === 0) {
        listHtml = '<p>No building styles available.</p>';
    } else {
        listHtml = `<ul class="item-list">${styleKeys.map(style => {
            const color = stringToColor(style);
            const highlightKey = `survey/style:${style}`;
            highlightFeatureCache[highlightKey] = styleGroups[style];
            return `<li class="filter-list-item" data-style="${style}">
                        <span class="filter-item-text">
                            <span class="color-swatch" style="background-color: ${color}"></span>
                            ${style} (${styleGroups[style].length})
                        </span>
                        ${renderHighlightButton(highlightKey, style)}
                    </li>`;
        }).join('')}</ul>`;
    }

    const followToggleHtml = `<button id="follow-map-toggle" class="pill ${isMapFollowEnabled ? 'active' : ''}">Follow map</button>`;
    sheetContent.innerHTML = `
        <div class="sheet-header">
            <h3><button class="back-button">&larr;</button>Building Style</h3>
            ${followToggleHtml}
        </div>
        <div class="scrollable-content">${listHtml}</div>
    `;
    toggleBottomSheet(true);
}


// --- SURVEY DETAIL PANELS (for filtered lists) ---

function buildColorCodeDetailPanel(color) {
    let features = surveyData.features.filter(f => f.properties.CHRS_Color === color);
    let filteredFeatures = features;

    if (isMapFollowEnabled) {
        const featuresInView = getFeaturesInView();
        const inViewIds = new Set(featuresInView.map(f => f.properties.BLDG_ID));
        filteredFeatures = features.filter(f => inViewIds.has(f.properties.BLDG_ID));
    }

    filteredFeatures.sort(propertySort);

    // Update global navigation list
    currentNavigationList = filteredFeatures;
    let listHtml = filteredFeatures.map(f => `<li data-id="${f.properties.BLDG_ID}"><a>${formatListItem(f.properties)}</a></li>`).join('');

    const highlightKey = `survey/color:${color}`;
    const highlightTargets = highlightFeatureCache[highlightKey] || features;
    highlightFeatureCache[highlightKey] = highlightTargets;
    setHighlight(highlightTargets, highlightKey);

    const followToggleHtml = `<button id="follow-map-toggle" class="pill ${isMapFollowEnabled ? 'active' : ''}">Follow map</button>`;
    sheetContent.innerHTML = `
        <div class="sheet-header">
            <h3><button class="back-button">&larr;</button>${color} (${filteredFeatures.length})</h3>
            ${followToggleHtml}
        </div>
        <div class="scrollable-content"><ul class="item-list">${listHtml}</ul></div>
    `;
    toggleBottomSheet(true);
    restoreScrollPosition();
}

function buildDecadeDetailPanel(decade) {
    let features = surveyData.features.filter(f => f.properties.decade === decade);
    let filteredFeatures = features;

    if (isMapFollowEnabled) {
        const featuresInView = getFeaturesInView();
        const inViewIds = new Set(featuresInView.map(f => f.properties.BLDG_ID));
        filteredFeatures = features.filter(f => inViewIds.has(f.properties.BLDG_ID));
    }

    filteredFeatures.sort(propertySort);

    // Update global navigation list
    currentNavigationList = filteredFeatures;
    let listHtml = filteredFeatures.map(f => `<li data-id="${f.properties.BLDG_ID}"><a>${formatListItem(f.properties)}</a></li>`).join('');

    const highlightKey = `survey/decade:${decade}`;
    const highlightTargets = highlightFeatureCache[highlightKey] || features;
    highlightFeatureCache[highlightKey] = highlightTargets;
    setHighlight(highlightTargets, highlightKey);

    const followToggleHtml = `<button id="follow-map-toggle" class="pill ${isMapFollowEnabled ? 'active' : ''}">Follow map</button>`;
    sheetContent.innerHTML = `
        <div class="sheet-header">
            <h3><button class="back-button">&larr;</button>${decade} (${filteredFeatures.length})</h3>
            ${followToggleHtml}
        </div>
        <div class="scrollable-content"><ul class="item-list">${listHtml}</ul></div>
    `;
    toggleBottomSheet(true);
    restoreScrollPosition();
}

function buildArchitectDetailPanel(architect) {
    let features = surveyData.features.filter(f => f.properties.CHRS_Architect === architect);
    let filteredFeatures = features;

    if (isMapFollowEnabled) {
        const featuresInView = getFeaturesInView();
        const inViewIds = new Set(featuresInView.map(f => f.properties.BLDG_ID));
        filteredFeatures = features.filter(f => inViewIds.has(f.properties.BLDG_ID));
    }

    filteredFeatures.sort(propertySort);

    // Update global navigation list
    currentNavigationList = filteredFeatures;
    let listHtml = filteredFeatures.map(f => `<li data-id="${f.properties.BLDG_ID}"><a>${formatListItem(f.properties)}</a></li>`).join('');

    const highlightKey = `survey/architect:${architect}`;
    const highlightTargets = highlightFeatureCache[highlightKey] || features;
    highlightFeatureCache[highlightKey] = highlightTargets;
    setHighlight(highlightTargets, highlightKey);

    const followToggleHtml = `<button id="follow-map-toggle" class="pill ${isMapFollowEnabled ? 'active' : ''}">Follow map</button>`;
    sheetContent.innerHTML = `
        <div class="sheet-header">
            <h3><button class="back-button">&larr;</button>${architect} (${filteredFeatures.length})</h3>
            ${followToggleHtml}
        </div>
        <div class="scrollable-content"><ul class="item-list">${listHtml}</ul></div>
    `;
    toggleBottomSheet(true);
    restoreScrollPosition();
}

function buildStyleDetailPanel(style) {
    let features = surveyData.features.filter(f => f.properties["CHRS_Building Style"] === style);
    let filteredFeatures = features;

    if (isMapFollowEnabled) {
        const featuresInView = getFeaturesInView();
        const inViewIds = new Set(featuresInView.map(f => f.properties.BLDG_ID));
        filteredFeatures = features.filter(f => inViewIds.has(f.properties.BLDG_ID));
    }

    filteredFeatures.sort(propertySort);

    // Update global navigation list
    currentNavigationList = filteredFeatures;
    let listHtml = filteredFeatures.map(f => `<li data-id="${f.properties.BLDG_ID}"><a>${formatListItem(f.properties)}</a></li>`).join('');

    const highlightKey = `survey/style:${style}`;
    const highlightTargets = highlightFeatureCache[highlightKey] || features;
    highlightFeatureCache[highlightKey] = highlightTargets;
    setHighlight(highlightTargets, highlightKey);

    const followToggleHtml = `<button id="follow-map-toggle" class="pill ${isMapFollowEnabled ? 'active' : ''}">Follow map</button>`;

    let footerHtmlDesktop = '';
    let footerHtmlMobile = '';

    if (window.buildingStyles && window.buildingStyles[style]) {
        const fullDesc = window.buildingStyles[style].description;
        const modalCall = `openStyleModal('${style.replace(/'/g, "\\'")}')`;

        // Truncate description to ~350 chars (approx 6 lines)
        let displayDesc = fullDesc;
        const limit = 350;
        if (fullDesc.length > limit) {
            // Cut at the last space before the limit
            const cutIndex = fullDesc.lastIndexOf(' ', limit);
            if (cutIndex > 0) {
                displayDesc = fullDesc.substring(0, cutIndex) + `<a href="#" onclick="return openStyleModal('${style.replace(/'/g, "\\'")}');" style="color: #4285F4; font-weight: bold; text-decoration: none; margin-left: 4px;">...</a>`;
            }
        }

        // Mobile Footer
        footerHtmlMobile = `
            <div class="mobile-footer" style="padding: 15px 20px; color: #666; font-size: 0.9em; line-height: 1.5; border-top: 1px solid #eee; margin-top: 15px;">
                ${displayDesc}
            </div>
        `;

        // Desktop Footer
        footerHtmlDesktop = `
            <div class="desktop-footer" style="padding: 15px 20px; color: #666; font-size: 0.9em; line-height: 1.5; border-top: 1px solid #eee; background-color: #f9f9f9;">
                ${displayDesc}
            </div>
        `;
    }

    sheetContent.innerHTML = `
        <div class="sheet-header">
            <h3><button class="back-button">&larr;</button>${style} (${filteredFeatures.length})</h3>
            ${followToggleHtml}
        </div>
        <div class="scrollable-content">
            <ul class="item-list">${listHtml}</ul>
            ${footerHtmlMobile}
        </div>
        ${footerHtmlDesktop}
    `;
    toggleBottomSheet(true);
    restoreScrollPosition();
}


// --- DISTRICT & PROPERTY PANELS ---

function buildDistrictDetailsPanel(districtFeature) {
    const districtName = districtFeature.properties.NAME;

    // Track district view in Google Analytics
    trackEvent('view_district', {
        district_name: districtName
    });

    clearHighlight();
    const districtGeom = districtFeature.geometry;

    // Prefer using the precomputed mapping if available for speed.
    let propertiesInside = [];
    if (districtFeatureMap && districtFeatureMap[districtName] && districtFeatureMap[districtName].length > 0) {
        propertiesInside = districtFeatureMap[districtName];
    } else {
        // Fallback: compute using precomputed centroids where possible.
        propertiesInside = surveyData.features.filter(propFeature => {
            try {
                // Use cached centroid when available to avoid calling turf.centroid repeatedly
                if (propFeature._centroid && typeof propFeature._centroid.lat === 'number') {
                    const pt = { type: 'Feature', geometry: { type: 'Point', coordinates: [propFeature._centroid.lng, propFeature._centroid.lat] } };
                    return iBooleanPointInPolygon(pt, districtGeom);
                }
                // Last-resort: compute centroid once
                const center = iCentroid(propFeature);
                return iBooleanPointInPolygon(center, districtGeom);
            } catch (e) { return false; }
        });
    }

    let filteredProperties = propertiesInside;
    if (isMapFollowEnabled) {
        const featuresInView = getFeaturesInView();
        const inViewIds = new Set(featuresInView.map(f => f.properties.BLDG_ID));
        filteredProperties = propertiesInside.filter(f => inViewIds.has(f.properties.BLDG_ID));
    }

    filteredProperties.sort(propertySort);

    // Update global navigation list
    currentNavigationList = filteredProperties;

    // *** FIX: Jump to Street Logic ***
    const districtsWithJump = ['Ridge Historic District', 'Brainerd Bungalow Historic District'];
    let jumpBarHtml = '';
    let listContentHtml = '';

    if (districtsWithJump.includes(districtName) && filteredProperties.length > 20) {
        // Group by Street Name
        const streetGroups = {};
        filteredProperties.forEach(f => {
            const stName = (f.properties.ST_NAME1 || 'Unknown').toUpperCase();
            if (!streetGroups[stName]) streetGroups[stName] = [];
            streetGroups[stName].push(f);
        });

        const sortedStreets = Object.keys(streetGroups).sort();

        // Build Jump Bar (Dropdown)
        jumpBarHtml = `<div class="jump-bar" style="padding: 10px 20px; background: #f9f9f9; border-bottom: 1px solid #eee;">
            <select id="jump-to-street-select" style="width: 100%; padding: 8px; border: 1px solid #ccc; border-radius: 4px; font-size: 0.9em;">
                <option value="" disabled selected>Jump to street...</option>
                ${sortedStreets.map(st => `<option value="street-${st.replace(/\s+/g, '-')}">${st}</option>`).join('')}
            </select>
        </div>`;

        // Build Grouped List
        listContentHtml = sortedStreets.map(st => {
            const items = streetGroups[st];
            const groupHtml = items.map(f => {
                let ribbonHtml = '';
                if (districtName === 'Ridge Historic District') {
                    const contrib = f.properties.contributing_ridge_historic_district;
                    let ribbonIcon = 'ribbon-outline.svg';
                    let ribbonTitle = 'Not contributing property in the Ridge Historic District';

                    if (contrib === 'Y') {
                        ribbonIcon = 'ribbon-gold.svg';
                        ribbonTitle = 'Contributing property to the Ridge Historic District';
                    }
                    ribbonHtml = `<img src="${ribbonIcon}" data-tooltip="${ribbonTitle}" style="height: 24px; width: 24px; margin-left: 10px; flex-shrink: 0; display: block;" />`;
                }

                return `<li data-id="${f.properties.BLDG_ID}">
                            <a style="display: flex; justify-content: space-between; align-items: center; width: 100%;">
                                <span>${formatListItem(f.properties)}</span>
                                ${ribbonHtml}
                            </a>
                        </li>`;
            }).join('');

            return `<div id="street-${st.replace(/\s+/g, '-')}" class="list-group">
                <h4 style="padding: 10px 20px; background: #eee; margin: 0; font-size: 0.9em; color: #555; border-top: 1px solid #ddd; border-bottom: 1px solid #ddd;">${st}</h4>
                <ul class="item-list" style="margin-top: 0;">${groupHtml}</ul>
            </div>`;
        }).join('');

    } else {
        // Standard List
        listContentHtml = filteredProperties.length === 0 ? '<p>No properties from the survey found in this district.</p>' :
            `<ul class="item-list">${filteredProperties.map(f => {
                let ribbonHtml = '';
                if (districtName === 'Ridge Historic District') {
                    const contrib = f.properties.contributing_ridge_historic_district;
                    let ribbonIcon = 'ribbon-outline.svg';
                    let ribbonTitle = 'Not contributing property in the Ridge Historic District';

                    if (contrib === 'Y') {
                        ribbonIcon = 'ribbon-gold.svg';
                        ribbonTitle = 'Contributing property to the Ridge Historic District';
                    }
                    ribbonHtml = `<img src="${ribbonIcon}" data-tooltip="${ribbonTitle}" style="height: 24px; width: 24px; margin-left: 10px; flex-shrink: 0; display: block;" />`;
                }

                return `<li data-id="${f.properties.BLDG_ID}">
                            <a style="display: flex; justify-content: space-between; align-items: center; width: 100%;">
                                <span>${formatListItem(f.properties)}</span>
                                ${ribbonHtml}
                            </a>
                        </li>`;
            }).join('')}</ul>`;
    }

    const followToggleHtml = `<button id="follow-map-toggle" class="pill ${isMapFollowEnabled ? 'active' : ''}">Follow map</button>`;
    sheetContent.innerHTML = `
        <div class="sheet-header">
            <h3><button class="back-button">&larr;</button>${districtName}</h3>
            ${followToggleHtml}
        </div>
        ${jumpBarHtml}
        <div class="scrollable-content">${listContentHtml}</div>
    `;
    toggleBottomSheet(true);
    restoreScrollPosition();

    // Add Jump Listeners
    if (jumpBarHtml) {
        const select = sheetContent.querySelector('#jump-to-street-select');
        if (select) {
            select.addEventListener('change', (e) => {
                const targetId = e.target.value;
                const targetEl = document.getElementById(targetId);
                const scrollContainer = sheetContent.querySelector('.scrollable-content');
                if (targetEl && scrollContainer) {
                    scrollContainer.scrollTo({
                        top: targetEl.offsetTop - scrollContainer.offsetTop,
                        behavior: 'smooth'
                    });
                }
            });
        }
    }

    if (districtName === 'Beverly/Morgan Park Railroad Station') {
        setHighlight(districtFeatureMap[districtName] || [], `district:${districtName}`);
    }
}

/* ============================================================
   MODAL & CONTENT SYSTEM
   ============================================================ */

const districtContent = {
    'Ridge Historic District': {
        title: 'Ridge Historic District',
        body: `
            <h4>About this District</h4>
            <p><b style="color: red;">This text copy is temporary/sample and will be replaced.</b> The Ridge Historic District is one of Chicago's largest historic districts, encompassing a significant collection of residential architecture from the late 19th and early 20th centuries.</p>
            <h4>Tax Incentives</h4>
            <p><b style="color: red;">This text copy is temporary/sample and will be replaced. </b>Properties within this district may be eligible for the <strong>Property Tax Assessment Freeze Program</strong>. This program freezes the assessed value of the property for 8-12 years if the owner undertakes a substantial rehabilitation.</p>
            <h4>Permit Requirements</h4>
            <p><b style="color: red;">This text copy is temporary/sample and will be replaced. </b>Exterior work visible from the public right-of-way requires review by the Commission on Chicago Landmarks. This ensures that alterations maintain the historic character of the district.</p>
            <p><a href="https://www.chicago.gov/city/en/depts/dcd/supp_info/landmarks/ridge_historic_district.html" target="_blank">Official City Page &rarr;</a></p>
        `
    },
    'Brainerd Bungalow Historic District': {
        title: 'Brainerd Bungalow Historic District',
        body: `
            <h4>About this District</h4>
            <p><b style="color: red;">This text copy is temporary/sample and will be replaced. </b>This district is a fine example of the "Chicago Bungalow" style that dominated residential construction in the early 20th century.</p>
            <h4>Historic Chicago Bungalow Association</h4> `
    },
    'Longwood Drive': {
        title: 'Longwood Drive Historic District',
        body: `
            <h4>About this District</h4>
            <p><b style="color: red;">This text copy is temporary/sample and will be replaced.</b> Known for its grand estate homes situated on the ridge, Longwood Drive features unique topography and high-style architecture.</p>
            <h4>Landmark Status</h4>
            <p>As a designated Chicago Landmark district, all exterior permits are reviewed by the Landmarks Commission.</p>
        `
    },
    'Walter Burley Griffin Place': {
        title: 'Walter Burley Griffin Place',
        body: `
            <h4>About this District</h4>
            <p><b style="color: red;">This text copy is temporary/sample and will be replaced.</b> This district includes unique collection of Prairie School homes designed by Walter Burley Griffin, a contemporary of Frank Lloyd Wright.</p>
        `
    },
    'Beverly/Morgan Park Railroad Station': {
        title: 'Railroad Station District',
        body: `
            <h4>About this District</h4>
            <p><b style="color: red;">This text copy is temporary/sample and will be replaced.</b> This district protects the historic Rock Island commuter rail stations that were vital to the development of the Beverly Hills and Morgan Park communities.</p>
        `
    },
    'Individual Landmark': {
        title: 'Individual Chicago Landmark',
        body: `
            <h4>Landmark Status</h4>
            <p><b style="color: red;">This text copy is temporary/sample and will be replaced.</b> This property is individually designated as a Chicago Landmark. It possesses significant historical or architectural value.</p>
            <h4>Requirements</h4>
            <p>Any work affecting the exterior (and sometimes interior features) requires a permit review by the Historic Preservation department and potentiall the Commission on Chicago Landmarks.</p>
        `
    },
    'CHRS': {
        title: 'Chicago Historic Resources Survey (CHRS)',
        body: `
            <h4>About the Survey</h4>
            <p><b style="color: red;">This text copy is temporary/sample and will be replaced.</b> Completed in 1996, the Chicago Historic Resources Survey (CHRS) identified approximately 17,000 properties of historical or architectural importance.</p>
            <h4>Significance</h4>
            <p>The survey is a research and planning tool. Inclusion in the CHRS does not automatically designate a building as a Chicago Landmark, but properties rated "Red" or "Orange" are subject to a demolition delay ordinance (up to 90 days) to explore preservation options.</p>
            <p><a href="https://webapps1.chicago.gov/landmarksweb/web/historicsurvey.htm" target="_blank">Learn more &rarr;</a></p>
        `
    },
    'CHRS_Color': {
        title: 'CHRS Color Codes',
        body: `
            <h4>Understanding the Colors</h4>
            <p><b style="color: red;">This text copy is temporary/sample and will be replaced.</b>  The survey assigned a color code to each property reflecting its significance relative to others in the survey.</p>
            <ul style="list-style: none; padding: 0;">
                <li style="margin-bottom: 10px;"><strong style="color: #FF0000;">Red</strong>: Significant in the broader context of the City of Chicago, the State of Illinois, or the United States of America.</li>
                <li style="margin-bottom: 10px;"><strong style="color: #FFA500;">Orange</strong>: Significant in the context of the surrounding community.</li>
                <li style="margin-bottom: 10px;"><strong style="color: #FFFF00;">Yellow</strong>: Relatively unaltered, pre-1940s, part of a concentration of significant buildings.</li>
                <li style="margin-bottom: 10px;"><strong style="color: #ADFF2F;">Yellow/Green</strong>: Pre-1940s whose exteriors were covered with artificial siding, part of a concentration of significant buildings.</li>
                <li style="margin-bottom: 10px;"><strong style="color: #008000;">Green</strong>: Pre-1940s whose exteriors have been slightly altered.</li>
                <li style="margin-bottom: 10px;"><strong style="color: #800080;">Purple</strong>: Pre-1940s whose exteriors have been extensively altered.</li>
                <li style="margin-bottom: 10px;"><strong style="color: #0000FF;">Blue</strong>: Constructed after 1940. Too recent to be properly evaluated for significance and were generally not included in the CHRS database.</li>
            </ul>
        `
    }
};

// Modal DOM Elements
const modalOverlay = document.getElementById('info-modal');
const modalTitle = document.getElementById('modal-title');
const modalBody = document.getElementById('modal-body');
const modalCloseBtn = document.getElementById('modal-close-btn');

function openModal(key, contentOverride = null) {
    let content;
    if (contentOverride) {
        content = { title: key, body: contentOverride };
    } else {
        content = districtContent[key] || { title: key, body: '<p>No additional information available.</p>' };
    }
    modalTitle.textContent = content.title;
    modalBody.innerHTML = content.body;
    modalOverlay.classList.add('active');

    // Track modal open in Google Analytics
    trackEvent('open_modal', {
        modal_title: content.title
    });
}

function closeModal() {
    modalOverlay.classList.remove('active');
}

// Modal Event Listeners
if (modalCloseBtn) {
    modalCloseBtn.addEventListener('click', closeModal);
    modalOverlay.addEventListener('click', (e) => {
        if (e.target === modalOverlay) closeModal();
    });
    // Close on Escape key
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && modalOverlay.classList.contains('active')) {
            closeModal();
        }
    });
}

/* ============================================================
   KEYBOARD NAVIGATION FOR PROPERTIES
   ============================================================ */
// Global keyboard navigation for property listings
document.addEventListener('keydown', (e) => {
    // Only handle arrow keys when not typing in an input field
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
        return;
    }

    // Check if property view is active (either mobile or desktop)
    const isPropertyViewActive =
        (bottomSheet && bottomSheet.classList.contains('property-view-active')) ||
        (rightSheet && rightSheet.classList.contains('property-view-active'));

    if (!isPropertyViewActive) {
        return;
    }

    // Handle left/right arrow keys
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        // Find the navigation buttons
        const prevBtn = document.querySelector('.prev-property:not([disabled])');
        const nextBtn = document.querySelector('.next-property:not([disabled])');

        if (e.key === 'ArrowLeft' && prevBtn) {
            e.preventDefault(); // Prevent page scrolling
            prevBtn.click();
        } else if (e.key === 'ArrowRight' && nextBtn) {
            e.preventDefault(); // Prevent page scrolling
            nextBtn.click();
        }
    }
});

// Global function to open style modal with description and images
window.openStyleModal = function (styleName) {
    if (window.buildingStyles && window.buildingStyles[styleName]) {
        const desc = window.buildingStyles[styleName].description;
        let content = `<div style="line-height: 1.6; color: #333;">${desc}</div>`;

        // Find up to 3 images
        if (surveyData && surveyData.features) {
            const matchingFeatures = surveyData.features.filter(f => {
                const s = f.properties['CHRS_Building Style'];
                return s === styleName && f.properties.PIN;
            });

            // Simple shuffle
            for (let i = matchingFeatures.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [matchingFeatures[i], matchingFeatures[j]] = [matchingFeatures[j], matchingFeatures[i]];
            }

            const examples = matchingFeatures.slice(0, 3);

            if (examples.length > 0) {
                content += '<div style="margin-top: 20px; border-top: 1px solid #eee; padding-top: 15px;">';
                content += '<h4 style="margin-bottom: 15px; color: #444;">Examples in Chicago Historic Resources Survey</h4>';
                examples.forEach(f => {
                    const addr = formatAddress(f.properties);
                    const year = f.properties.CHRS_Built_Date || f.properties.YEAR_BUILT || 'Unknown Year';

                    // Construct Image URL from PIN
                    let imgUrl = null;
                    const rawPin = f.properties.PIN ? String(f.properties.PIN) : null;
                    if (rawPin) {
                        const cleanedPin = rawPin.replace(/^0+/, '');
                        if (cleanedPin.length > 0) {
                            const paddedPin = cleanedPin.padEnd(14, '0');
                            imgUrl = `https://maps.cookcountyil.gov/groundphotos/${paddedPin}`;
                        }
                    }

                    if (imgUrl) {
                        content += `
                            <div style="margin-bottom: 20px;">
                                <div style="background-color: transparent; border-radius: 8px;">
                                    <img src="${imgUrl}" alt="${addr}" style="width: 100%; display: block; clip-path: inset(0 0 13% 0 round 8px); margin-bottom: -7%;" onerror="this.parentElement.parentElement.style.display='none'">
                                </div>
                                <div style="font-size: 0.85em; color: #666; margin-top: 2px; font-weight: 500; text-align: center; position: relative; z-index: 1;">${addr} (${year})</div>
                            </div>
                        `;
                    }
                });
                content += '</div>';
            }
        }
        openModal(styleName, content);
    } else {
        openModal(styleName, '<p>No additional information available.</p>');
    }
    return false; // Prevent default link navigation
};

/* ============================================================
   SHEET UPDATE LOGIC
   ============================================================ */
function updateSheetContent(address, props, imageHtml) {
    const val = (field) => (field === null || typeof field === 'undefined' || String(field).trim() === '') ? null : field;
    // If on desktop and rightSheetContent exists, render property into right panel.
    const targetContent = (window.innerWidth >= 768 && rightSheetContent) ? rightSheetContent : sheetContent;

    // Build historic districts list based on boolean/flag properties
    const districtFlags = [
        { key: 'ridge_historic_district', label: 'Ridge Historic District' },
        { key: 'brainerd_bungalow_historic_district', label: 'Brainerd Bungalow Historic District' },
        { key: 'longwood_drive_historic_district', label: 'Longwood Drive' },
        { key: 'walter_burley_griffin_place', label: 'Walter Burley Griffin Place' },
        { key: 'railroad_station_district', label: 'Beverly/Morgan Park Railroad Station' }
    ];
    const districts = [];
    districtFlags.forEach(df => {
        try {
            if (props && props[df.key]) {
                // Treat any truthy/non-null value as membership
                districts.push(df.label);
            }
        } catch (e) { }
    });
    if (props && props.individual_landmark) {
        const v = String(props.individual_landmark).trim().toUpperCase();
        if (v === 'Y' || v === 'YES') districts.push('Individual Landmark');
    }

    // Helper to create info button HTML
    const infoIcon = `<svg class="info-icon" viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/></svg>`;

    const districtsHtml = districts.length > 0 ?
        `<ul class="district-list">${districts.map(d => {
            let ribbonHtml = '';
            if (d === 'Ridge Historic District') {
                // Check if contributing
                const contrib = val(props.contributing_ridge_historic_district);
                if (contrib === 'Y') {
                    ribbonHtml = `<img src="ribbon-gold.svg" data-tooltip="Contributing property to the Ridge Historic District" style="height: 18px; width: 18px; margin-left: 8px; vertical-align: middle; display: inline-block;" />`;
                } else {
                    ribbonHtml = `<img src="ribbon-outline.svg" data-tooltip="Non-contributing property in the Ridge Historic District" style="height: 18px; width: 18px; margin-left: 8px; vertical-align: middle; display: inline-block;" />`;
                }
            }
            return `
            <li style="display: flex; align-items: center; justify-content: space-between;">
                <span style="display: flex; align-items: center;">&bull; ${d}${ribbonHtml}</span>
                <button class="info-btn" data-district="${d}" style="flex-shrink: 0;">
                    ${infoIcon} Info
                </button>
            </li>`;
        }).join('')}</ul>`
        : '<div class="district-none">None</div>';

    // Helper for Color Code
    const getColorHex = (colorName) => {
        if (!colorName) return '#333';
        const c = colorName.toLowerCase();
        if (c === 'yellow/green') return '#ADFF2F';
        if (c.includes('red')) return '#d32f2f';
        if (c.includes('orange')) return '#f57c00';
        if (c.includes('yellow')) return '#fbc02d';
        if (c.includes('green')) return '#388e3c';
        if (c.includes('purple')) return '#7b1fa2';
        if (c.includes('blue')) return '#1976d2';
        return '#333';
    };

    // CHRS section
    const inChrs = val(props && props.CHRS_Address);
    const colorVal = val(props.CHRS_Color);
    const colorHex = getColorHex(colorVal);

    const chrsHtml = inChrs ? `
        <div class="property-meta">
            <div class="meta-row"><span class="meta-key">Address:</span><span class="meta-val">${props.CHRS_Address}</span></div>
            <div class="meta-row"><span class="meta-key">PIN:</span><span class="meta-val">${val(props.CHRS_PIN) || 'N/A'}</span></div>
            <div class="meta-row"><span class="meta-key">Year built:</span><span class="meta-val">${val(props.CHRS_Built_Date) || 'N/A'}*</span></div>
            <div class="meta-row"><span class="meta-key">Architect:</span><span class="meta-val">${val(props.CHRS_Architect)
            ? `<a href="#survey/architect/${encodeURIComponent(props.CHRS_Architect)}" style="color: var(--primary); text-decoration: underline;">${props.CHRS_Architect}</a>`
            : 'N/A'
        }</span></div>
            <div class="meta-row"><span class="meta-key">Style:</span><span class="meta-val">${(() => {
            const s = val(props['CHRS_Building Style']);
            if (!s) return 'N/A';
            if (window.buildingStyles && window.buildingStyles[s]) {
                return `<a href="#" class="style-link" data-style="${s}" style="color: #333; text-decoration: underline; text-decoration-style: dotted; text-decoration-color: #999; cursor: pointer;">${s}</a>`;
            }
            return `<a href="#survey/style/${encodeURIComponent(s)}" style="color: inherit; text-decoration: none; border-bottom: 1px dotted #999;">${s}</a>`;
        })()}</span></div>
            <div class="meta-row"><span class="meta-key">Building type:</span><span class="meta-val">${val(props.CHRS_Type) || 'N/A'}</span></div>
            <div class="meta-row">
                <span class="meta-key">Color code:</span>
                <span class="meta-val">
                    ${colorVal ? `<button class="info-btn" data-district="CHRS_Color" style="margin: 0; padding: 0; color: ${colorHex}; text-decoration: underline; text-decoration-style: dotted; text-decoration-color: #999; cursor: pointer; font-weight: bold; background-color: transparent !important;">${colorVal}</button>` : 'N/A'}
                </span>
            </div>
        </div>
    ` : '<div style="color: #666;">Not in survey</div>';

    // Chicago city data
    const cityHtml = `
        <div class="property-meta">
            <div class="meta-row"><span class="meta-key">PIN:</span><span class="meta-val">${val(props.PIN) || 'N/A'}</span></div>
            <div class="meta-row"><span class="meta-key">Year built:</span><span class="meta-val">${val(props.YEAR_BUILT) || 'N/A'}*</span></div>
        </div>
    `;

    // Building name HTML with tooltip
    const buildingName = val(props.building_name);
    const buildingNameSource = val(props.building_name_source);
    const buildingNameHtml = buildingName ?
        `<div style="color: #888; font-size: 0.9em; font-weight: 400;" title="${buildingNameSource || 'Source unknown'}">${buildingName}</div>`
        : '';

    // Determine navigation state
    let navHtml = '';
    let prevId = null;
    let nextId = null;

    if (!isMapFollowEnabled && currentNavigationList && currentNavigationList.length > 0) {
        const currentIndex = currentNavigationList.findIndex(f => f.properties.BLDG_ID === props.BLDG_ID);
        if (currentIndex !== -1) {
            const total = currentNavigationList.length;
            const displayIndex = currentIndex + 1;

            // Circular navigation or bounded? Usually bounded is better for lists.
            // Let's do bounded for now.
            if (currentIndex > 0) prevId = currentNavigationList[currentIndex - 1].properties.BLDG_ID;
            if (currentIndex < total - 1) nextId = currentNavigationList[currentIndex + 1].properties.BLDG_ID;

            // Use CSS classes instead of inline styles
            navHtml = `
            <div class="property-nav">
                <button class="nav-btn prev-property" ${prevId ? `data-id="${prevId}"` : 'disabled'}>&larr;</button>
                <span style="font-size: 0.9em; color: #666; font-weight: 500; min-width: 40px; text-align: center;">${displayIndex}/${total}</span>
                <button class="nav-btn next-property" ${nextId ? `data-id="${nextId}"` : 'disabled'}>&rarr;</button>
            </div>`;
        }
    }

    const isDesktop = window.innerWidth >= 768;

    targetContent.innerHTML = `
        <div class="sheet-header property-sheet-header">
            <button class="close-property-button" style="position: static; margin-right: 15px; flex-shrink: 0;">&times;</button>
            <div style="display: flex; flex-direction: column; gap: 4px; flex-grow: 1;">
                <h3 style="margin: 0; line-height: 1.2;">${address}</h3>
                ${buildingNameHtml}
            </div>
            ${!isDesktop ? navHtml : ''}
        </div>
        <div class="scrollable-content">
            ${imageHtml}
            <div class="property-card">
                <div class="property-section">
                    <h4>Historic Districts</h4>
                    ${districtsHtml}
                </div>

                <div class="property-section">
                    <div style="display: flex; align-items: center; justify-content: space-between; border-bottom: 2px solid #f0f0f0; margin-bottom: 15px; padding-bottom: 10px;">
                        <h4 style="border: none; margin: 0; padding: 0;">Chicago Historic Resources Survey</h4>
                        <button class="info-btn" data-district="CHRS">
                            ${infoIcon} Info
                        </button>
                    </div>
                    ${chrsHtml}
                </div>

                <div class="property-section">
                    <h4>Chicago city data</h4>
                    ${cityHtml}
                </div>

                <p class="prop-note">* Note: Year built data should be verified with the <a href="https://researchguides.uic.edu/CBP" target="_blank">original building permit</a>.</p>
                
                <div style="margin-top: 20px; text-align: center;">
                    <button id="view-report-btn" style="
                        background-color: var(--primary); 
                        color: white; 
                        border: none; 
                        padding: 12px 24px; 
                        border-radius: 8px; 
                        font-weight: 600; 
                        cursor: pointer; 
                        box-shadow: var(--shadow-md);
                        transition: background-color 0.2s;
                        display: inline-flex;
                        align-items: center;
                        gap: 8px;
                    ">
                        <svg style="width: 18px; height: 18px; fill: currentColor;" viewBox="0 0 24 24"><path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-5 14H7v-2h7v2zm3-4H7v-2h10v2zm0-4H7V7h10v2z"/></svg>
                        View Full Report
                    </button>
                </div>
                <br><br>
            </div>
        </div>
        ${isDesktop && navHtml ? `<div class="desktop-nav-float">${navHtml}</div>` : ''}
    `;

    // Attach Event Listeners

    // 0. Navigation Buttons
    const prevBtn = targetContent.querySelector('.prev-property');
    const nextBtn = targetContent.querySelector('.next-property');

    if (prevBtn) {
        prevBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const id = e.currentTarget.dataset.id;
            if (id) window.location.hash = `#property/${id}`;
        });
    }

    if (nextBtn) {
        nextBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const id = e.currentTarget.dataset.id;
            if (id) window.location.hash = `#property/${id}`;
        });
    }

    // 1. Close Button
    // 1. Close Button
    const closeBtn = targetContent.querySelector('.close-property-button');
    if (closeBtn) {
        closeBtn.addEventListener('click', (e) => {
            e.preventDefault(); // Prevent any default action
            e.stopPropagation(); // Stop bubbling

            if (window.innerWidth >= 768) {
                // Desktop: hide right sheet
                if (rightSheet) rightSheet.classList.remove('property-view-active');
                appContainer.classList.remove('panel-open');
                // Re-center map if needed
                setTimeout(() => map.invalidateSize(), 300);
            } else {
                // Mobile: Return to the last list view if available
                if (lastListHash && lastListHash !== '#') {
                    window.location.hash = lastListHash;
                } else {
                    // Fallback: minimize and clear hash
                    bottomSheet.classList.remove('property-view-active');
                    toggleBottomSheet(false);
                    // Clear hash if it's a property hash
                    if (window.location.hash.startsWith('#property/')) {
                        // Use replaceState to avoid history clutter, but we want to trigger hashchange?
                        // Actually, setting hash to '' triggers hashchange which calls showDefaultPanel.
                        // That's acceptable behavior for "Close" if no history.
                        window.location.hash = '';
                    }
                }
            }

            // Clear selection
            if (selectedFeatureLayer) {
                geoJsonLayer.resetStyle(selectedFeatureLayer);
                selectedFeatureLayer = null;
            }
            // Clear district highlight if any
            if (selectedDistrictLayer) {
                districtsLayer.resetStyle(selectedDistrictLayer);
                selectedDistrictLayer = null;
            }
        });
    }

    // 2. Info Buttons (Delegation or direct attachment)
    const infoBtns = targetContent.querySelectorAll('.info-btn');
    infoBtns.forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation(); // Prevent bubbling
            const districtName = btn.getAttribute('data-district');
            openModal(districtName);
        });
    });

    // 2.5 Style Links
    // Event delegation for style links
    document.addEventListener('click', function (e) {
        if (e.target && e.target.classList.contains('style-link')) {
            e.preventDefault();
            const styleName = e.target.dataset.style;
            window.openStyleModal(styleName);
        }
    });

    // 3. Full Report Button
    const reportBtn = targetContent.querySelector('#view-report-btn');
    if (reportBtn) {
        reportBtn.addEventListener('click', () => {
            generateFullReport(address, props, imageHtml);
        });
    }
}

function generateFullReport(address, props, imageHtml) {
    // Simple report generation: Open a new window and write HTML to it
    const reportWindow = window.open('', '_blank');
    if (!reportWindow) {
        alert('Please allow popups to view the full report.');
        return;
    }

    const val = (field) => (field === null || typeof field === 'undefined' || String(field).trim() === '') ? 'N/A' : field;

    // Extract image URL if present in imageHtml
    let imgUrl = '';
    const imgMatch = imageHtml.match(/src="([^"]+)"/);
    if (imgMatch) imgUrl = imgMatch[1];

    const htmlContent = `
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Report: ${address}</title>
            <style>
                body { font-family: 'Inter', sans-serif; line-height: 1.6; color: #333; max-width: 800px; margin: 0 auto; padding: 40px; }
                h1 { border-bottom: 2px solid #eee; padding-bottom: 20px; margin-bottom: 30px; }
                h2 { color: #2c3e50; margin-top: 40px; border-bottom: 1px solid #eee; padding-bottom: 10px; }
                .report-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 40px; }
                .report-meta { color: #666; font-size: 0.9em; }
                .property-image { width: 100%; max-height: 500px; object-fit: cover; border-radius: 8px; margin-bottom: 40px; background-color: #f0f0f0; }
                .data-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 20px; }
                .data-item { margin-bottom: 10px; }
                .data-label { font-weight: 600; color: #666; display: block; font-size: 0.85em; text-transform: uppercase; letter-spacing: 0.5px; }
                .data-value { font-size: 1.1em; }
                .footer { margin-top: 60px; padding-top: 20px; border-top: 1px solid #eee; text-align: center; color: #888; font-size: 0.8em; }
                @media print {
                    body { padding: 0; }
                    .no-print { display: none; }
                }
            </style>
            <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;600;700&display=swap" rel="stylesheet">
        </head>
        <body>
            <div class="report-header">
                <div>
                    <h1>Property Report</h1>
                    <div class="report-meta">Generated on ${new Date().toLocaleDateString()}</div>
                </div>
                <div style="text-align: right;">
                    <div style="font-size: 1.5em; font-weight: 700;">${address}</div>
                    <div>PIN: ${val(props.PIN)}</div>
                </div>
            </div>

            ${imgUrl ? `<img src="${imgUrl}" class="property-image" alt="${address}">` : ''}

            <h2>Historic Designations</h2>
            <div class="data-grid">
                <div class="data-item">
                    <span class="data-label">Ridge Historic District</span>
                    <span class="data-value">${props.ridge_historic_district ? 'Yes' : 'No'}</span>
                </div>
                <div class="data-item">
                    <span class="data-label">Brainerd Bungalow Dist.</span>
                    <span class="data-value">${props.brainerd_bungalow_historic_district ? 'Yes' : 'No'}</span>
                </div>
                <div class="data-item">
                    <span class="data-label">Individual Landmark</span>
                    <span class="data-value">${val(props.individual_landmark)}</span>
                </div>
            </div>

            <h2>Chicago Historic Resources Survey (CHRS)</h2>
            <div class="data-grid">
                <div class="data-item"><span class="data-label">Survey Address</span><span class="data-value">${val(props.CHRS_Address)}</span></div>
                <div class="data-item"><span class="data-label">Architect</span><span class="data-value">${val(props.CHRS_Architect)}</span></div>
                <div class="data-item"><span class="data-label">Date Built</span><span class="data-value">${val(props.CHRS_Built_Date)}</span></div>
                <div class="data-item"><span class="data-label">Style</span><span class="data-value">${val(props['CHRS_Building Style'])}</span></div>
                <div class="data-item"><span class="data-label">Color Code</span><span class="data-value">${val(props.CHRS_Color)}</span></div>
            </div>

            <h2>Additional Data</h2>
            <div class="data-grid">
                <div class="data-item"><span class="data-label">Assessor Year Built</span><span class="data-value">${val(props.YEAR_BUILT)}</span></div>
                <div class="data-item"><span class="data-label">Original Owner</span><span class="data-value">${val(props.CHRS_Owner)}</span></div>
            </div>

            <div class="footer">
                Ridge Survey Application &bull; Data provided by City of Chicago & Cook County
            </div>
            
            <script>
                window.onload = function() { window.print(); }
            </script>
        </body>
        </html>
    `;

    reportWindow.document.write(htmlContent);
    reportWindow.document.close();
}

function buildPropertyCard(props) {
    // DEBUG: Log entry into buildPropertyCard
    console.log('[DEBUG] Entered buildPropertyCard for', props.BLDG_ID, props);
    if (window.hideTooltip) window.hideTooltip(); // Clear any stuck tooltips immediately
    try {
        // DEBUG: Log property selection and time to help diagnose freezes
        try {
            console.log('[DEBUG] Selecting property', props.BLDG_ID, props);
            window._propertySelectStart = Date.now();

            // Track property view in Google Analytics
            trackEvent('view_property', {
                property_id: props.BLDG_ID,
                // address removed for privacy
                district_name: findDistrictNameForProperty(props.BLDG_ID) || 'None',
                has_landmark_status: props.individual_landmark === 'Y' || props.individual_landmark === 'YES',
                color_code: props.CHRS_Rating || 'N/A'
            });
        } catch (e) { }
        const address = formatAddress(props);
        const val = (field) => field || 'N/A';
        // DEBUG: Log before rendering property card
        try {
            const t1 = Date.now();
            console.log('[DEBUG] Rendering property card for', props.BLDG_ID, 'at', t1, 'elapsed since select:', t1 - window._propertySelectStart, 'ms');
        } catch (e) { }

        // Create placeholder image HTML
        // Use cached aspect ratio if available, otherwise default to 3:2 (0.66)
        const aspectRatio = (cachedImageDimensions && cachedImageDimensions.aspectRatio)
            ? cachedImageDimensions.aspectRatio
            : 0.666; // Default to 3:2 landscape

        const paddingTop = (aspectRatio * 100).toFixed(2);

        // We use the SAME structure for placeholder and final image to prevent jumps
        // The container uses padding-top to enforce aspect ratio
        const placeholderImageHtml = `
            <div class="property-image">
                <div class="aspect-ratio-container" style="position: relative; width: 100%; padding-top: ${paddingTop}%; background-color: #f5f5f5; border-radius: 8px; overflow: hidden;">
                    <div class="placeholder-content" style="position: absolute; top: 0; left: 0; width: 100%; height: 100%; display: flex; align-items: center; justify-content: center;">
                        <div style="color: #999; font-size: 14px; font-weight: 500;">Loading...</div>
                    </div>
                </div>
            </div>`;

        // Immediately render the card with placeholder
        updateSheetContent(address, props, placeholderImageHtml);

        // Helper to update placeholder text
        const setNoImage = () => {
            const targetContent = (window.innerWidth >= 768 && rightSheetContent) ? rightSheetContent : sheetContent;
            const imageContainer = targetContent.querySelector('.property-image');
            if (imageContainer) {
                const placeholderContent = imageContainer.querySelector('.placeholder-content');
                if (placeholderContent) {
                    placeholderContent.innerHTML = '<div style="color: #bbb;">No image available</div>';
                }
            }
        };

        // Asynchronously try to load the image.
        try {
            const rawPin = props.PIN ? String(props.PIN) : null;
            if (rawPin) {
                const cleanedPin = rawPin.replace(/^0+/, '');
                if (cleanedPin.length > 0) {
                    const paddedPin = cleanedPin.padEnd(14, '0');
                    const imgUrl = `https://maps.cookcountyil.gov/groundphotos/${paddedPin}`;
                    const tempImg = new Image();
                    tempImg.src = imgUrl;

                    // DEBUG: Log before image load starts
                    try {
                        const t2 = Date.now();
                        console.log('[DEBUG] Starting image load for', props.BLDG_ID, imgUrl, 'at', t2, 'elapsed since select:', t2 - window._propertySelectStart, 'ms');
                    } catch (e) { }

                    tempImg.onload = () => {
                        if (window.hideTooltip) window.hideTooltip();

                        try {
                            const t3 = Date.now();
                            console.log('[DEBUG] Image loaded for', props.BLDG_ID, 'at', t3, 'elapsed since select:', t3 - window._propertySelectStart, 'ms');
                        } catch (e) { }

                        // Cache the aspect ratio (height/width) for next time
                        if (tempImg.naturalWidth && tempImg.naturalHeight) {
                            cachedImageDimensions = {
                                aspectRatio: tempImg.naturalHeight / tempImg.naturalWidth
                            };
                        }

                        // Find the container
                        const targetContent = (window.innerWidth >= 768 && rightSheetContent) ? rightSheetContent : sheetContent;
                        const imageContainer = targetContent.querySelector('.property-image');

                        if (imageContainer) {
                            // We replace the INNER content of the aspect-ratio-container
                            // This keeps the container height fixed (no jump)
                            // If the new image has a different aspect ratio, we update the padding-top
                            // But since we cached it, it should match. If it doesn't (first load), it might jump slightly,
                            // but using the container wrapper minimizes the visual impact.

                            const aspectRatioContainer = imageContainer.querySelector('.aspect-ratio-container');
                            if (aspectRatioContainer) {
                                // Update aspect ratio if we have new dimensions (to match the actual image perfectly)
                                if (tempImg.naturalWidth && tempImg.naturalHeight) {
                                    const newAspectRatio = tempImg.naturalHeight / tempImg.naturalWidth;
                                    aspectRatioContainer.style.paddingTop = `${(newAspectRatio * 100).toFixed(2)}%`;
                                }

                                aspectRatioContainer.innerHTML = `
                                    <a href="${imgUrl}" target="_blank" rel="noopener" style="position: absolute; top: 0; left: 0; width: 100%; height: 100%;">
                                        <img src="${imgUrl}" alt="Ground photo for ${address}" style="width: 100%; height: 100%; object-fit: cover;" loading="lazy" decoding="async" />
                                    </a>`;
                            }
                        }
                    };

                    tempImg.onerror = () => {
                        try {
                            const t4 = Date.now();
                            console.log('[DEBUG] Image failed to load for', props.BLDG_ID, 'at', t4, 'elapsed since select:', t4 - window._propertySelectStart, 'ms');
                        } catch (e) { }
                        console.debug('Image failed to load:', imgUrl);
                        setNoImage();
                    };
                } else {
                    // PIN exists but is empty after cleaning
                    setNoImage();
                }
            } else {
                // No PIN property
                setNoImage();
            }
        } catch (e) {
            console.debug('Could not build property image URL from PIN', e);
            setNoImage();
        }
    } catch (err) {
        console.error('[DEBUG] Error in buildPropertyCard', err);
    }


    if (window.innerWidth >= 768 && rightSheet) {
        if (rightSheet) {
            rightSheet.classList.add('property-view-active');
        }
        appContainer.classList.add('panel-open');
        bottomSheet.classList.add('expanded');
    } else {
        // Mobile: show bottom sheet property view
        bottomSheet.classList.add('property-view-active');
        toggleBottomSheet(true);
    }

    // Ensure district highlight remains if we're in a district context.
    try {
        if (activeDistrictContext) {
            const df = allDistricts.find(d => d.properties && d.properties.NAME === activeDistrictContext);
            if (df && !selectedDistrictLayer) {
                console.debug('[DEBUG] buildPropertyCard: re-highlighting district', activeDistrictContext);
                highlightDistrict(df);
            }
        }
    } catch (e) { console.debug('Error ensuring district highlight', e); }
}


// ---------------------------------------------------------------
//  5. HELPER FUNCTIONS
// ---------------------------------------------------------------

/**
 * Sets the panel to its default "Explore" state.
 */
function showDefaultPanel() {
    clearHighlight();
    sheetContent.innerHTML = `
        <div class="sheet-header"><h3>Welcome</h3></div>
        <div class="scrollable-content" style="padding: 0 20px 20px 20px; line-height: 1.6; color: #444;">
            <p style="margin-bottom: 16px;">
                This website helps residents and visitors understand the historic districts and landmarks in <strong>Beverly Hills, Morgan Park, and Washington Heights</strong>.
            </p>
            <p style="margin-bottom: 16px;">
                Building owners can determine if a property is in a historic district and understand potential <strong>financial incentives</strong> or <strong>permit requirements</strong> for alterations.
            </p>
        <div style="background-color: #f0f7ff; border-left: 4px solid var(--primary); padding: 12px; margin-bottom: 20px; border-radius: 4px;">
            <strong>Getting Started:</strong><br>
            Search for your address see if your building has a landmark designation or is included in the 1995 Chicago Historic Resources Survey (CHRS).
            
            <div style="margin-top: 10px; margin-bottom: 0; position: relative;" id="welcome-search-container">
                <svg style="position: absolute; left: 12px; top: 50%; transform: translateY(-50%); width: 20px; height: 20px; color: #666; pointer-events: none;" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"></path></svg>
                <input type="text" id="welcome-search-input" placeholder="Search address..." autocomplete="off" style="width: 100%; padding: 12px 12px 12px 40px; border: 1px solid #ccc; border-radius: 8px; font-size: 16px; box-sizing: border-box;">
                <div id="welcome-search-results" class="search-results-dropdown" style="display: none; position: absolute; top: 100%; left: 0; right: 0; background: white; border: 1px solid #ddd; border-radius: 8px; max-height: 200px; overflow-y: auto; z-index: 1000; box-shadow: 0 4px 6px rgba(0,0,0,0.1);"></div>
            </div>
        </div>
        
        <p style="font-size: 0.9em; color: #666; margin-top: 30px; border-top: 1px solid #eee; padding-top: 15px;">
            <em>Created by Tim Blackburn for the the Ridge Historical Society. (v0.7)</em>
        </p>
    </div>
    `;

    // *** Add logic for the welcome search bar ***
    setTimeout(() => {
        const container = sheetContent.querySelector('#welcome-search-container');
        if (container) {
            const input = container.querySelector('#welcome-search-input');
            const dropdown = container.querySelector('#welcome-search-results');

            if (input) {
                // Handle search input
                let debounceTimeout;
                input.addEventListener('input', (e) => {
                    clearTimeout(debounceTimeout);
                    debounceTimeout = setTimeout(() => {
                        const rawQuery = e.target.value;
                        if (rawQuery.length > 0) {
                            const results = searchFeatures(rawQuery);
                            renderWelcomeSearchResults(results, dropdown, input);
                        } else {
                            dropdown.style.display = 'none';
                        }
                    }, 150);
                });

                // Expand panel on focus (mobile) so keyboard doesn't cover it
                input.addEventListener('focus', (e) => {
                    if (window.innerWidth < 768) {
                        // Expand panel immediately
                        bottomSheet.style.height = 'calc(100vh - 130px)';
                        bottomSheet.classList.add('expanded');
                        bottomSheet.style.transform = 'translateY(0)';
                        bottomSheet.style.overscrollBehavior = 'contain';

                        // Use scrollIntoView repeatedly to handle animation
                        const startTime = Date.now();
                        const duration = 600; // Run for 600ms

                        const keepInView = () => {
                            const now = Date.now();
                            if (now - startTime > duration) return;

                            input.scrollIntoView({ block: 'center', behavior: 'auto' });
                            requestAnimationFrame(keepInView);
                        };

                        requestAnimationFrame(keepInView);
                    }
                });

                // Blur input when user starts scrolling/dragging (to allow panel to be dragged down)
                // But NOT when touching the input itself OR the dropdown
                const scrollableContent = sheetContent.querySelector('.scrollable-content');
                if (scrollableContent) {
                    scrollableContent.addEventListener('touchstart', (e) => {
                        // Only blur if NOT touching the input or dropdown
                        const isTouchingInputOrDropdown = e.target === input ||
                            input.contains(e.target) ||
                            e.target === dropdown ||
                            dropdown.contains(e.target) ||
                            e.target.closest('.search-results-dropdown');

                        if (document.activeElement === input && !isTouchingInputOrDropdown) {
                            input.blur();
                        }
                    }, { passive: true });
                }

                // Also blur when touching the sheet handle to drag
                const handle = document.querySelector('.handle');
                if (handle) {
                    handle.addEventListener('touchstart', () => {
                        if (document.activeElement === input) {
                            input.blur();
                        }
                    }, { passive: true });
                }

                // Restore normal behavior on blur
                input.addEventListener('blur', () => {
                    if (window.innerWidth < 768) {
                        setTimeout(() => {
                            const scrollableContent = sheetContent.querySelector('.scrollable-content');

                            // Keep panel expanded but restore normal middle position
                            bottomSheet.style.height = '';  // Reset height to default 45vh
                            bottomSheet.classList.add('expanded');  // Keep it at middle position
                            bottomSheet.style.transform = '';  // Reset transform
                            bottomSheet.style.overscrollBehavior = '';  // Allow normal scrolling

                            // Reset scroll
                            if (scrollableContent) {
                                scrollableContent.scrollTop = 0;  // Reset to top for consistency
                            }
                        }, 100);
                    }
                });
            }

            input.addEventListener('input', (e) => {
                const query = e.target.value.toLowerCase().trim();
                if (query.length < 3) {
                    dropdown.style.display = 'none';
                    return;
                }
                const results = surveyData.features.filter(f => {
                    const address = formatAddress(f.properties).toLowerCase();
                    return address.includes(query);
                }).slice(0, 10); // Limit to 10

                if (results.length > 0) {
                    dropdown.innerHTML = results.map(f => `
                        <div class="search-result-item" data-id="${f.properties.BLDG_ID}" data-address="${formatAddress(f.properties)}" style="padding: 10px 16px; cursor: pointer; border-bottom: 1px solid #eee;">
                            ${formatAddress(f.properties)}
                        </div>
                    `).join('');
                    dropdown.style.display = 'block';

                    // Add click listeners to items
                    dropdown.querySelectorAll('.search-result-item').forEach(item => {
                        item.addEventListener('click', () => {
                            const bldgId = item.dataset.id;
                            const address = item.dataset.address;

                            // Fill input and hide dropdown
                            input.value = address;
                            dropdown.style.display = 'none';

                            attemptShowProperty(bldgId);
                        });
                    });
                } else {
                    dropdown.style.display = 'none';
                }
            });

            // Hide on outside click
            document.addEventListener('click', (e) => {
                if (!container.contains(e.target)) {
                    dropdown.style.display = 'none';
                }
            });
        }
    }, 0);

    // On mobile, default panel to middle position (expanded)
    if (window.innerWidth < 768) {
        bottomSheet.classList.add('expanded');
    }
}

/**
 * Search Dropdown Functions
 */
function showSearchDropdown(query) {
    if (!query || query.length < 2) {
        clearSearchDropdown();
        return;
    }

    const results = searchFeatures(query);
    currentDropdownResults = results; // Store for "Enter" key logic

    if (results.length === 0) {
        clearSearchDropdown();
        return;
    }

    let listHtml = results.map(f => {
        const address = formatAddress(f.properties);
        return `<li data-id="${f.properties.BLDG_ID}">${address}</li>`;
    }).join('');

    searchResultsDropdown.innerHTML = `<ul>${listHtml}</ul>`;
    searchResultsDropdown.classList.add('active');

    // Add click listeners to new items
    searchResultsDropdown.querySelectorAll('li').forEach(li => {
        li.addEventListener('click', () => {
            attemptShowProperty(li.dataset.id);
            clearSearchDropdown();
            searchInput.value = ''; // Clear search input
        });
    });
}

function clearSearchDropdown() {
    currentDropdownResults = [];
    searchResultsDropdown.classList.remove('active');
    searchResultsDropdown.innerHTML = '';
}


/**
 * Show/Hide main districts layer
 */
function showDistrictsLayer() {
    if (nationalDistrictsLayer && !map.hasLayer(nationalDistrictsLayer)) {
        nationalDistrictsLayer.addTo(map);
    }
    if (chicagoDistrictsLayer && !map.hasLayer(chicagoDistrictsLayer)) {
        chicagoDistrictsLayer.addTo(map);
    }
}
function hideDistrictsLayer() {
    if (nationalDistrictsLayer && map.hasLayer(nationalDistrictsLayer)) {
        map.removeLayer(nationalDistrictsLayer);
    }
    if (chicagoDistrictsLayer && map.hasLayer(chicagoDistrictsLayer)) {
        map.removeLayer(chicagoDistrictsLayer);
    }
}

/**
 * Sets opacity on both district layers
 */
function setDistrictLayerOpacity(opacity) {
    if (nationalDistrictsLayer) {
        nationalDistrictsLayer.setStyle({ fillOpacity: opacity, opacity: opacity > 0.2 ? 0.5 : 0.2 });
    }
    if (chicagoDistrictsLayer) {
        chicagoDistrictsLayer.setStyle({ fillOpacity: opacity, opacity: opacity > 0.2 ? 0.5 : 0.2 });
    }
}

/**
 * Removes the selected district highlight
 */
function clearDistrictHighlight() {
    try { console.trace('[TRACE] clearDistrictHighlight called, currentHash=', window.location.hash); } catch (e) { }
    if (selectedDistrictLayer) {
        console.debug('[DEBUG] clearDistrictHighlight: removing selectedDistrictLayer');
        map.removeLayer(selectedDistrictLayer);
        selectedDistrictLayer = null;
    }
    const hash = window.location.hash;
    if (hash === '#' || hash === '#districts') {
        showDistrictsLayer();
    }
}

/**
Removes the red highlight layer from the map.
*/
function clearBuildingHighlight() {
    if (selectedBuildingLayer) {
        map.removeLayer(selectedBuildingLayer);
        selectedBuildingLayer = null;
    }
}

/**
Adds a highlight layer for a single district.
*/
function highlightDistrict(feature) {
    console.debug('[DEBUG] highlightDistrict: highlighting district', feature && feature.properties && (feature.properties.NAME || feature.properties.name));
    clearDistrictHighlight();
    hideDistrictsLayer(); // Hide the main layer

    const color = getDistrictColor(feature.properties.NAME);

    selectedDistrictLayer = L.geoJSON(feature, {
        style: { color: color, weight: 3, fillColor: color, fillOpacity: 0.5 },
        interactive: false,
        pane: 'selectedDistrictPane'
    }).addTo(map);
    console.debug('[DEBUG] highlightDistrict: selectedDistrictLayer added');
}

/**
Adds a red highlight layer for a single building.
*/
function highlightBuilding(feature) {
    clearBuildingHighlight();
    selectedBuildingLayer = L.geoJSON(feature, {
        style: { color: '#FF0000', weight: 3, fillOpacity: 0.1 },
        pane: 'highlightPane'
    }).addTo(map);
}

/**
 * Fits the map to bounds, accounting for the panel.
 */
function zoomToFeature(feature, maxZoom = null, viewOpts = {}) {
    const bounds = turf.bbox(feature);
    let options = {};
    const offsetScale = (viewOpts && typeof viewOpts.offsetScale === 'number') ? viewOpts.offsetScale : 1;

    if (window.innerWidth < 768) {
        // Mobile: 45vh bottom panel
        const panelHeight = map.getSize().y * 0.45;
        // DEBUG: Log property selection and time to help diagnose freezes
        try {
            const t0 = Date.now();
            console.log('[DEBUG] Selecting property', props.BLDG_ID, props);
            window._propertySelectStart = t0;
        } catch (e) { }

        // DEBUG: Log before rendering property card
        try {
            const t1 = Date.now();
            console.log('[DEBUG] Rendering property card for', props.BLDG_ID, 'at', t1, 'elapsed since select:', t1 - window._propertySelectStart, 'ms');
        } catch (e) { }
        // DEBUG: Log property selection and time to help diagnose freezes
        try {
            const t0 = Date.now();
            console.log('[DEBUG] Selecting property', props.BLDG_ID, props);
            window._propertySelectStart = t0;
        } catch (e) { }

        // DEBUG: Log before rendering property card
        try {
            const t1 = Date.now();
            console.log('[DEBUG] Rendering property card for', props.BLDG_ID, 'at', t1, 'elapsed since select:', t1 - window._propertySelectStart, 'ms');
        } catch (e) { }
        options = {
            paddingTopLeft: [40, 40],
            paddingBottomRight: [40, panelHeight + 20]
        };
    } else {
        // Desktop: the `#map` element is already offset in CSS (left: 400px),
        // so using a large left padding here pushed the fitted bounds to the right.
        // Use a small symmetric padding and a closer default maxZoom so districts
        // are centered and appear more zoomed-in.
        options = {
            paddingTopLeft: [40, 40],
            paddingBottomRight: [40, 40]
        };
        options.maxZoom = 17; // allow a closer zoom for district fits
        // DEBUG: Log before image load starts
        try {
            const t2 = Date.now();
            console.log('[DEBUG] Starting image load for', props.BLDG_ID, imgUrl, 'at', t2, 'elapsed since select:', t2 - window._propertySelectStart, 'ms');
        } catch (e) { }
        // DEBUG: Log before image load starts
        try {
            try {
                const t3 = Date.now();
                console.log('[DEBUG] Image loaded for', props.BLDG_ID, 'at', t3, 'elapsed since select:', t3 - window._propertySelectStart, 'ms');
            } catch (e) { }
            const t2 = Date.now();
            console.log('[DEBUG] Starting image load for', props.BLDG_ID, imgUrl, 'at', t2, 'elapsed since select:', t2 - window._propertySelectStart, 'ms');
        } catch (e) { }
    }
    // If a maxZoom is explicitly passed (i.e., for a single property), use it.
    try {
        const t3 = Date.now();
        console.log('[DEBUG] Image loaded for', props.BLDG_ID, 'at', t3, 'elapsed since select:', t3 - window._propertySelectStart, 'ms');
    } catch (e) { }
    // Otherwise, let fitBounds decide the best zoom level for districts.
    if (maxZoom) {
        try {
            const t4 = Date.now();
            console.log('[DEBUG] Image failed to load for', props.BLDG_ID, 'at', t4, 'elapsed since select:', t4 - window._propertySelectStart, 'ms');
        } catch (e) { }
        options.maxZoom = maxZoom;
    }

    const boundsLatLng = L.latLngBounds([[bounds[1], bounds[0]], [bounds[3], bounds[2]]]);

    // Compute a target maxZoom BEFORE calling fitBounds to avoid a double
    // animation (fitBounds then a subsequent setZoom). We allow fitBounds
    // to choose the zoom up to `targetZoom` so the map lands at the closer
    // zoom in a single animation.
    try {
        const t4 = Date.now();
        console.log('[DEBUG] Image failed to load for', props.BLDG_ID, 'at', t4, 'elapsed since select:', t4 - window._propertySelectStart, 'ms');
    } catch (e) { }
    if (maxZoom != null) {
        options.maxZoom = maxZoom;
    } else {
        try {
            const idealZoom = map.getBoundsZoom(boundsLatLng);
            const capZoom = options.maxZoom || 17;
            const targetZoom = Math.min(idealZoom + 1, capZoom);
            options.maxZoom = targetZoom;
        } catch (e) {
            // Fallback: keep whatever options.maxZoom was set to
            console.warn('Could not compute ideal zoom for bounds; using default maxZoom.', e);
        }
    }

    // If a right-side panel overlays the map on desktop, nudge the
    // fitBounds by adding half that width to the right padding so the
    // feature appears centered in the visible region between panels.
    try {
        const rightHalf = getRightPanelHalfOffsetPx(offsetScale);
        if (rightHalf) {
            options.paddingBottomRight = options.paddingBottomRight || [40, 40];
            options.paddingBottomRight[0] = (options.paddingBottomRight[0] || 40) + rightHalf;
        }
    } catch (e) { }
    map.fitBounds(boundsLatLng, options);
}

/**
 * Toggles the panel open/closed.
 */
function toggleBottomSheet(forceExpand = null) {
    const isDesktop = window.innerWidth >= 768;

    if (isDesktop) {
        // On desktop, we only control the appContainer class for map offset
        const shouldBeOpen = (forceExpand === null) ? !appContainer.classList.contains('panel-open') : forceExpand;

        if (shouldBeOpen) {
            appContainer.classList.add('panel-open');
        } else {
            appContainer.classList.remove('panel-open');
        }
        // Ensure sheet is "expanded" so it's visible
        if (!bottomSheet.classList.contains('expanded')) {
            bottomSheet.classList.add('expanded');
        }
    } else {
        // On mobile, we toggle the bottom sheet 'expanded' class
        const shouldBeOpen = (forceExpand === null) ? !bottomSheet.classList.contains('expanded') : forceExpand;

        if (shouldBeOpen) {
            bottomSheet.classList.add('expanded');
        } else {
            bottomSheet.classList.remove('expanded');
        }
    }

    // Tell Leaflet to resize the map after the CSS transition
    setTimeout(() => map.invalidateSize(), 300);
}

/**
 * Restores the saved scroll position for the current route
 */
function restoreScrollPosition() {
    const currentHash = window.location.hash || '';
    if (savedScrollPositions[currentHash] !== undefined) {
        const scrollableContent = bottomSheet.querySelector('.scrollable-content');
        if (scrollableContent) {
            // Use setTimeout to ensure the DOM is fully rendered
            setTimeout(() => {
                scrollableContent.scrollTop = savedScrollPositions[currentHash];
            }, 50);
        }
    }
}


/**
 * Handles window resize to move pills between mobile/desktop containers
 */
function handleResize() {
    const isDesktop = window.innerWidth >= 768;
    const desktopPillContainer = document.querySelector('#bottom-sheet');
    const mobilePillContainer = document.querySelector('#top-ui');

    if (isDesktop) {
        // Move pills to side panel
        desktopPillContainer.prepend(filterPillsContainer);
        // *** FIX: Always set panel-open and expanded on desktop ***
        appContainer.classList.add('panel-open');
        bottomSheet.classList.add('expanded');
    } else {
        // Move pills to top-ui
        mobilePillContainer.appendChild(filterPillsContainer);
        appContainer.classList.remove('panel-open');
        // Let hash router decide if panel is expanded
        if (window.location.hash && window.location.hash !== '#') {
            bottomSheet.classList.add('expanded');
        } else {
            bottomSheet.classList.remove('expanded');
        }
    }
    // Resize map
    setTimeout(() => map.invalidateSize(), 100);
}

function formatAddress(props) {
    let parts = [];
    if (props.F_ADD1) parts.push(props.F_ADD1);
    if (props.PRE_DIR1) parts.push(props.PRE_DIR1);
    if (props.ST_NAME1) parts.push(props.ST_NAME1);
    if (props.ST_TYPE1) parts.push(props.ST_TYPE1);
    return parts.length > 0 ? parts.join(' ') : props.address || '';
}

/**
 * Calculates Levenshtein distance between two strings
 */
function levenshteinDistance(a, b) {
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;

    const matrix = [];

    // increment along the first column of each row
    for (let i = 0; i <= b.length; i++) {
        matrix[i] = [i];
    }

    // increment each column in the first row
    for (let j = 0; j <= a.length; j++) {
        matrix[0][j] = j;
    }

    // Fill in the rest of the matrix
    for (let i = 1; i <= b.length; i++) {
        for (let j = 1; j <= a.length; j++) {
            if (b.charAt(i - 1) === a.charAt(j - 1)) {
                matrix[i][j] = matrix[i - 1][j - 1];
            } else {
                matrix[i][j] = Math.min(
                    matrix[i - 1][j - 1] + 1, // substitution
                    Math.min(
                        matrix[i][j - 1] + 1, // insertion
                        matrix[i - 1][j] + 1 // deletion
                    )
                );
            }
        }
    }

    return matrix[b.length][a.length];
}

/**
 * Performs fuzzy search on survey features
 */
function searchFeatures(rawQuery) {
    if (!rawQuery || rawQuery.length === 0) return [];
    const query = normalizeSearchQuery(rawQuery);

    const scored = surveyData.features.map(f => {
        const addr = formatAddress(f.properties);
        const normAddr = normalizeSearchQuery(addr);
        let score = 100;

        if (normAddr.includes(query)) {
            score = 0; // Exact substring match
            if (normAddr.startsWith(query)) score = -1; // Prefix match bonus
        } else {
            // Fuzzy match against prefix
            const prefix = normAddr.substring(0, query.length);
            const dist = levenshteinDistance(query, prefix);
            if (dist <= 3) score = dist;
        }
        return { feature: f, score };
    });

    return scored
        .filter(item => item.score < 10)
        .sort((a, b) => a.score - b.score)
        .slice(0, 10)
        .map(item => item.feature);
}

/**
 * Normalizes search query by handling abbreviations and punctuation.
 */
function normalizeSearchQuery(query) {
    if (!query) return '';
    let q = query.toUpperCase().trim();

    // Remove periods (e.g. "St." -> "St", "W." -> "W")
    q = q.replace(/\./g, '');

    // Remove ordinal suffixes (e.g. "1st" -> "1", "108th" -> "108")
    // This ensures "108th" matches "108" in the database
    q = q.replace(/(\d+)(ST|ND|RD|TH)\b/g, '$1');

    // Replace full words with abbreviations
    const replacements = {
        'STREET': 'ST',
        'AVENUE': 'AVE',
        'BOULEVARD': 'BLVD',
        'PLACE': 'PL',
        'ROAD': 'RD',
        'DRIVE': 'DR',
        'LANE': 'LN',
        'COURT': 'CT',
        'TERRACE': 'TER',
        'NORTH': 'N',
        'SOUTH': 'S',
        'EAST': 'E',
        'WEST': 'W'
    };

    // Replace whole words only
    for (const [full, abbr] of Object.entries(replacements)) {
        q = q.replace(new RegExp(`\\b${full}\\b`, 'g'), abbr);
    }

    return q;
}

/**
 * Formats a list item with address and optional building name
 */
function formatListItem(props) {
    const address = formatAddress(props);
    const buildingName = props.building_name;

    if (buildingName) {
        return `
            <div>${address}</div>
            <div style="color: #888; font-size: 0.85em; margin-top: 2px;">${buildingName}</div>
        `;
    }
    return address;
}

/**
 * Sorts two features by Street Name, then House Number
 */
function propertySort(a, b) {
    const propsA = a.properties;
    const propsB = b.properties;
    const stNameA = propsA.ST_NAME1 || '';
    const stNameB = propsB.ST_NAME1 || '';
    if (stNameA < stNameB) return -1;
    if (stNameA > stNameB) return 1;
    return (propsA.F_ADD1 || 0) - (propsB.F_ADD1 || 0);
}

/**
 * Updates the active pill highlight
 */
function updateActivePill(activeFilter) {
    document.querySelectorAll('#filter-pills .pill').forEach(pill => {
        if (pill.dataset.filter === activeFilter) {
            pill.classList.add('active-pill');
        } else {
            pill.classList.remove('active-pill');
        }
    });
}

/**
 * Updates the survey layer style and filter based on mode.
 */
function updateSurveyLayer(mode, filterValue = null) {
    if (surveyLayer && map.hasLayer(surveyLayer)) {
        map.removeLayer(surveyLayer);
    }

    let styleFunc = getSurveyStyle; // Default (clear)
    let filterFunc = null;       // Default (show all)

    if (mode === 'districts-filter') {
        styleFunc = getSurveyStyle;
        if (filterValue && filterValue instanceof Set) {
            filterFunc = (feature) => filterValue.has(feature.properties.BLDG_ID);
        } else {
            filterFunc = () => false;
        }
    } else if (mode === 'landmarks') {
        styleFunc = getSurveyStyle;
        filterFunc = (feature) => {
            // Include Chicago Landmarks
            const landmark = feature && feature.properties && feature.properties.individual_landmark;
            const isLandmark = landmark && (String(landmark).trim().toUpperCase() === 'Y' || String(landmark).trim().toUpperCase() === 'YES');

            // Include Contributing Properties to Ridge Historic District
            const contributing = feature && feature.properties && feature.properties.contributing_ridge_historic_district;
            const isContributing = contributing && (String(contributing).trim().toUpperCase() === 'Y' || String(contributing).trim().toUpperCase() === 'YES');

            return isLandmark || isContributing;
        };
    } else if (mode === 'color') {
        styleFunc = (feature) => {
            const color = feature.properties.CHRS_Color;
            if (color) {
                let fillColor = color.toLowerCase();
                if (fillColor === 'yellow/green') fillColor = '#ADFF2F';
                return {
                    fillColor: fillColor, fillOpacity: 0.6,
                    color: '#000000', weight: 1, opacity: 0.5
                };
            }
            return getSurveyStyle(feature);
        };
        if (filterValue) {
            filterFunc = (feature) => feature.properties.CHRS_Color === filterValue;
        }
    } else if (mode === 'decade') {
        styleFunc = (feature) => {
            const decade = feature.properties.decade;
            if (decade) {
                return {
                    fillColor: getDecadeColor(decade), fillOpacity: 0.6,
                    color: '#000000', weight: 1, opacity: 0.5
                };
            }
            return getSurveyStyle(feature);
        };
        if (filterValue) {
            filterFunc = (feature) => feature.properties.decade === filterValue;
        }
    } else if (mode === 'architect') {
        styleFunc = (feature) => {
            const architect = feature.properties.CHRS_Architect;
            if (architect) {
                return {
                    fillColor: stringToColor(architect), fillOpacity: 0.6,
                    color: '#000000', weight: 1, opacity: 0.5
                };
            }
            return getSurveyStyle(feature);
        };
        if (filterValue) {
            filterFunc = (feature) => feature.properties.CHRS_Architect === filterValue;
        }
    } else if (mode === 'style') {
        styleFunc = (feature) => {
            const style = feature.properties["CHRS_Building Style"];
            if (style) {
                return {
                    fillColor: stringToColor(style), fillOpacity: 0.6,
                    color: '#000000', weight: 1, opacity: 0.5
                };
            }
            return getSurveyStyle(feature);
        };
        if (filterValue) {
            filterFunc = (feature) => feature.properties["CHRS_Building Style"] === filterValue;
        }
    } else if (mode === 'district') {
        // Show only the properties that are part of the named district.
        styleFunc = getSurveyStyle;
        if (filterValue && districtFeatureMap && districtFeatureMap[filterValue]) {
            const idSet = new Set(districtFeatureMap[filterValue].map(f => f.properties.BLDG_ID));
            filterFunc = (feature) => idSet.has(feature.properties.BLDG_ID);
        } else {
            // If we can't find the mapping, hide everything to avoid showing
            // unrelated properties.
            filterFunc = () => false;
        }
    }

    // Only for Building Survey views, require a non-empty `CHRS_Address`
    // so outlines in survey panels exclude features without a CHRS address.
    try {
        const isSurveyRoute = (window.location.hash && String(window.location.hash).startsWith('#survey'));
        if (isSurveyRoute && (mode === 'default' || mode === 'color' || mode === 'decade' || mode === 'architect' || mode === 'style')) {
            const prevFilter = filterFunc;
            filterFunc = (feature) => {
                try {
                    const addr = feature && feature.properties && feature.properties.CHRS_Address;
                    const hasAddr = addr !== null && typeof addr !== 'undefined' && String(addr).trim() !== '';
                    if (!hasAddr) return false;
                    return typeof prevFilter === 'function' ? prevFilter(feature) : true;
                } catch (e) {
                    return false;
                }
            };
        }
    } catch (e) {
        // swallow errors — don't block rendering
    }

    surveyLayer = L.geoJSON(null, {
        style: styleFunc,
        filter: filterFunc,
        onEachFeature: baseSurveyLayer.options.onEachFeature,
        pane: 'buildingPane'
    });

    surveyLayer.addData(surveyData);
    surveyLayer.addTo(map);
}

/** Highlight helpers ******************************************************/
function showHighlightCircles(features) {
    if (!features || !Array.isArray(features) || features.length === 0) return;
    const points = features.map(f => {
        let lng, lat;
        if (f._centroid && typeof f._centroid.lat === 'number') {
            lng = f._centroid.lng; lat = f._centroid.lat;
        } else {
            try {
                const c = iCentroid(f);
                if (c && c.geometry && c.geometry.coordinates) {
                    lng = c.geometry.coordinates[0]; lat = c.geometry.coordinates[1];
                }
            } catch (e) { }
        }
        if (typeof lng === 'number' && typeof lat === 'number') {
            return {
                type: 'Feature',
                geometry: { type: 'Point', coordinates: [lng, lat] },
                properties: f.properties
            };
        }
        return null;
    }).filter(Boolean);
    if (points.length === 0) return;

    removeHighlightCircles();

    // Calculate radius based on zoom level
    const zoom = map.getZoom();
    let radius;
    if (zoom >= 18) {
        radius = 36; // Triple size for closest zoom (was 12)
    } else if (zoom >= 17) {
        radius = 36; // Triple size for second closest zoom (was 12) 
    } else if (zoom >= 16) {
        radius = 24; // Double size for third closest zoom (was 12)
    } else {
        radius = 12; // Default size for other zooms
    }

    highlightLayer = L.geoJSON({ type: 'FeatureCollection', features: points }, {
        pane: 'highlightPane',
        pointToLayer: (feat, latlng) => L.circleMarker(latlng, {
            radius: radius,
            color: '#FFD54F',
            fillColor: '#FFD54F',
            fillOpacity: 0.55,
            weight: 0,
            className: 'highlight-glow'
        })
    }).addTo(map);
}

function removeHighlightCircles() {
    try {
        if (highlightLayer) {
            map.removeLayer(highlightLayer);
            highlightLayer = null;
        }
    } catch (e) {
        console.debug('removeHighlightCircles error', e);
    }
}

function resetHighlightButtonState() {
    if (highlightControlButton) {
        highlightControlButton.classList.remove('highlight-active');
        highlightControlButton = null;
    }
}

function setHighlight(features, origin, controlButton = null) {
    removeHighlightCircles();
    resetHighlightButtonState();
    highlightOrigin = null;
    if (!features || features.length === 0) {
        return;
    }
    if (controlButton) {
        highlightControlButton = controlButton;
        highlightControlButton.classList.add('highlight-active');
    }
    highlightOrigin = origin || null;
    showHighlightCircles(features);
}

function clearHighlight() {
    removeHighlightCircles();
    resetHighlightButtonState();
    highlightOrigin = null;
}

function renderHighlightButton(highlightKey, label) {
    if (!highlightKey) return '';
    const safeLabel = label ? label.replace(/"/g, '&quot;') : 'Highlight';
    // Use the project SVG file (flat marker) that the user added at project root.
    // The image is rendered inside the circular button and sized via CSS.
    return `
        <button type="button" class="highlight-toggle" data-highlight-key="${highlightKey}" aria-label="Highlight ${safeLabel}">
            <img class="highlight-icon" src="marker-tool-svgrepo-com.svg" alt="" aria-hidden="true" />
        </button>`;
}

function handleHighlightToggle(button) {
    if (!button) return;
    const key = button.dataset.highlightKey;
    if (!key) return;
    const features = highlightFeatureCache[key] || [];
    if (highlightOrigin === key) {
        clearHighlight();
        return;
    }
    setHighlight(features, key, button);
}

/**************************************************************************/

/**
 * The default (clear) style for survey buildings
 */
function getSurveyStyle(feature) {
    return {
        fillColor: '#FFFFFF', fillOpacity: 0.0,
        color: '#000000', weight: 1, opacity: 0.5
    };
}

/**
 * Style function for the main districts layer
 */
function getDistrictStyle(feature, defaultOpacity = 0.2) {
    const name = feature.properties.NAME;
    const color = getDistrictColor(name);
    return {
        fillColor: color,
        fillOpacity: defaultOpacity,
        color: color,
        weight: 2,
        opacity: defaultOpacity + 0.3
    };
}


/**
 * Parses CHRS_Built_Date into a decade
 */
function getDecade(dateStr) {
    if (!dateStr || typeof dateStr !== 'string') return null;

    const match = dateStr.match(/\d{4}/);
    if (!match) return null;

    const year = parseInt(match[0], 10);

    if (year < 1880) return "1870s or earlier";
    if (year < 1890) return "1880s";
    if (year < 1900) return "1890s";
    if (year < 1910) return "1900s";
    if (year < 1920) return "1910s";
    if (year < 1930) return "1920s";
    if (year < 1940) return "1930s";
    return "1940 or later";
}

/**
 * Gets all features currently in the map bounds
 */
function getFeaturesInView() {
    const mapBounds = getVisibleMapBounds();
    // Use precomputed centroids (set during preprocessSurveyData) to avoid
    // expensive turf.centroid calls on every map move.
    return surveyData.features.filter(f => {
        try {
            if (f && f._centroid && typeof f._centroid.lat === 'number') {
                const latLng = L.latLng(f._centroid.lat, f._centroid.lng);
                return mapBounds.contains(latLng);
            }
            // If centroid isn't available, fall back to attempting a centroid
            // (but this should be rare because preprocessSurveyData sets it).
            const center = iCentroid(f);
            const latLng = L.latLng(center.geometry.coordinates[1], center.geometry.coordinates[0]);
            return mapBounds.contains(latLng);
        } catch (e) {
            // Avoid throwing; just treat as out-of-view
            return false;
        }
    });
}

/**
 * Returns the map bounds that are visible to the user, excluding any
 * overlaying right-side panel on desktop. This ensures "Follow map"
 * filters exclude features hidden behind the right panel.
 */
function getVisibleMapBounds() {
    try {
        const size = map.getSize();
        let visibleWidth = size.x;
        // If desktop and right sheet is visible and overlaid, subtract its width
        if (window.innerWidth >= 768 && rightSheet && rightSheet.classList.contains('property-view-active')) {
            visibleWidth = Math.max(0, size.x - rightSheet.offsetWidth);
        }
        const topLeft = map.containerPointToLatLng([0, 0]);
        const bottomRight = map.containerPointToLatLng([visibleWidth, size.y]);
        return L.latLngBounds(topLeft, bottomRight);
    } catch (e) {
        return map.getBounds();
    }
}

/**
 * Returns true if a given building id is included in the currently
 * displayed `surveyLayer` (i.e. not filtered out by the active survey
 * filter). If the surveyLayer isn't present, assume it's visible.
 */
function isPropertyIncludedInSurveyLayer(bldgId) {
    try {
        if (!surveyLayer) return true;
        const layers = surveyLayer.getLayers ? surveyLayer.getLayers() : [];
        for (let i = 0; i < layers.length; i++) {
            const lf = layers[i];
            const id = lf && lf.feature && lf.feature.properties && lf.feature.properties.BLDG_ID;
            if (typeof id !== 'undefined' && String(id) === String(bldgId)) return true;
        }
    } catch (e) {
        console.debug('isPropertyIncludedInSurveyLayer error', e);
    }
    return false;
}

/**
 * Returns true if the building both passes the current survey filter
 * (is included in surveyLayer) AND its centroid falls inside the
 * currently visible map bounds (taking right panel into account).
 */
function isPropertyVisibleInCurrentFilter(bldgId) {
    try {
        // Find feature in full dataset
        const feature = surveyData.features.find(f => String(f.properties.BLDG_ID) === String(bldgId));
        if (!feature) return false;

        // If it's filtered out of the survey layer, it's not visible
        if (!isPropertyIncludedInSurveyLayer(bldgId)) return false;

        // Only check map bounds if "Follow map" is enabled
        if (isMapFollowEnabled) {
            const mapBounds = getVisibleMapBounds();
            if (feature._centroid && typeof feature._centroid.lat === 'number') {
                const latLng = L.latLng(feature._centroid.lat, feature._centroid.lng);
                return mapBounds.contains(latLng);
            }
            // Fallback: compute centroid once
            const c = iCentroid(feature);
            if (c && c.geometry && c.geometry.coordinates) {
                const latLng = L.latLng(c.geometry.coordinates[1], c.geometry.coordinates[0]);
                return mapBounds.contains(latLng);
            }
            return false;
        }
        // If not following map, just check filter inclusion
        return true;
    } catch (e) {
        console.debug('isPropertyVisibleInCurrentFilter error', e);
    }
    return false;
}

/**
 * Attempt to show a property while respecting current filters/view.
 * If the property is visible under current filters, navigate to it.
 * Otherwise prompt the user to clear filters and show it.
 */
function attemptShowProperty(bldgId) {
    if (typeof bldgId === 'undefined' || bldgId === null) return;
    if (window.hideTooltip) window.hideTooltip(); // Clear any stuck tooltips
    try {
        const idStr = String(bldgId);
        if (isPropertyVisibleInCurrentFilter(idStr)) {
            window.location.hash = `#property/${idStr}`;
            return;
        }

        // Not visible: prompt user to clear filters and view it.
        const msg = 'That address does not match the current map filtering. Clear filters and view the building?';
        if (window.confirm(msg)) {
            // Navigate to home (clears filters) then open property after a short delay
            navigateHomeWithTrace('attemptShowProperty: clearing filters for search');
            setTimeout(() => {
                try { window.location.hash = `#property/${idStr}`; } catch (e) { console.debug('Could not set hash to property after clearing filters', e); }
            }, 180);
        } else {
            // user cancelled: do nothing
        }
    } catch (e) { console.debug('attemptShowProperty error', e); }
}

/**
 * Generates a consistent, non-random color from a string (for CHRS)
 */
function stringToColor(str) {
    if (!str) return '#CCCCCC';

    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
    }

    const scaledHue = Math.abs(hash % 240);
    const finalHue = (scaledHue > 40) ? scaledHue + 120 : scaledHue;

    return `hsl(${finalHue}, 80%, 60%)`;
}

/**
 * Returns a distinct color for a given decade.
 */
function getDecadeColor(decade) {
    if (!decade) return '#CCCCCC';
    const d = decade.toLowerCase();
    if (d.includes('1870')) return '#8E24AA'; // Purple
    if (d.includes('1880')) return '#D81B60'; // Pink
    if (d.includes('1890')) return '#E53935'; // Red
    if (d.includes('1900')) return '#FB8C00'; // Orange
    if (d.includes('1910')) return '#FDD835'; // Yellow
    if (d.includes('1920')) return '#43A047'; // Green
    if (d.includes('1930')) return '#00897B'; // Teal
    if (d.includes('1940')) return '#1E88E5'; // Blue
    return stringToColor(decade); // Fallback
}

/**
 * Finds the district name (key) that contains a given building id
 * using the precomputed `districtFeatureMap`. Returns the district
 * name string or null if not found.
 */
function findDistrictNameForProperty(bldgId) {
    // Fast path: use reverse index if available
    if (bldgIdToDistrict && typeof bldgIdToDistrict[bldgId] !== 'undefined') {
        return bldgIdToDistrict[bldgId] || null;
    }
    // Fallback: scan districtFeatureMap if reverse index isn't built
    if (!districtFeatureMap) return null;
    try {
        for (const dname in districtFeatureMap) {
            const arr = districtFeatureMap[dname];
            if (!arr || arr.length === 0) continue;
            for (let i = 0; i < arr.length; i++) {
                const f = arr[i];
                if (f && f.properties && f.properties.BLDG_ID === bldgId) return dname;
            }
        }
    } catch (e) {
        console.debug('findDistrictNameForProperty error', e);
    }
    return null;
}

/**
 * Gets a color for a district
 */
function getDistrictColor(str) {
    if (!str) return '#CCCCCC';

    if (districtConfig[str]) {
        return districtConfig[str].color;
    }

    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        hash = str.charCodeAt(i) + ((hash << 5) - hash);
    }
    const index = Math.abs(hash) % districtFallbackPalette.length;
    return districtFallbackPalette[index];
}


/**
 * One-time data pre-processing
 */
function preprocessSurveyData() {
    surveyData.features.forEach(f => {
        const props = f.properties;
        const decade = getDecade(props.CHRS_Built_Date);
        if (decade) {
            f.properties.decade = decade;
        }
        // Precompute centroids (lat/lng) once so getFeaturesInView can be
        // fast and avoid calling turf.centroid repeatedly on map moves.
        try {
            // Use pre-calculated centroids if available
            if (props.Centroid_X !== undefined && props.Centroid_Y !== undefined) {
                f._centroid = {
                    lng: Number(props.Centroid_X),
                    lat: Number(props.Centroid_Y)
                };
            } else {
                // Fallback to runtime calculation
                const c = iCentroid(f);
                if (c && c.geometry && c.geometry.coordinates) {
                    f._centroid = {
                        lng: c.geometry.coordinates[0],
                        lat: c.geometry.coordinates[1]
                    };
                }
            }
        } catch (e) {
            // If centroid computation fails, leave _centroid undefined.
            // getFeaturesInView will fall back to a one-off turf.centroid.
            console.debug('Could not compute centroid for a feature during preprocess', e && e.message ? e.message : e);
        }
    });
}

/**
 * Main click handler for the location button
 */
function handleLocationClick() {
    if (locationMode === 'off' || locationMode === 'error') {
        trackEvent('location_button', { action: 'enable' });
        map.locate({
            watch: true,
            setView: true,
            maxZoom: 17
        });
        setLocationMode('following');
    } else {
        trackEvent('location_button', { action: 'disable' });
        disableLocation();
    }
}

/**
 * Stops all location services
 */
function disableLocation() {
    map.stopLocate();
    if (locationMarker) {
        map.removeLayer(locationMarker);
        locationMarker = null;
    }
    setLocationMode('off');
}

/**
 * Fires when location is found
 */
function handleLocationFound(e) {
    const radius = e.accuracy / 2;

    if (locationMarker) {
        locationMarker.setLatLng(e.latlng).setRadius(radius);
    } else {
        locationMarker = L.circle(e.latlng, radius, {
            pane: 'locationPane',
            color: '#4285F4',
            fillColor: '#4285F4',
            fillOpacity: 0.15,
            weight: 2
        }).addTo(map);
    }

    if (locationMode === 'following') {
        smartSetView(e.latlng, map.getZoom() || 17);
    }
}

/**
 * Fires if location service fails
 */
function handleLocationError(e) {
    console.error("Location error:", e.message);
    disableLocation();
    setLocationMode('error');
}

/**
 * Updates the button's class to show the correct icon
 */
function setLocationMode(mode) {
    locationMode = mode;
    locationButton.className = `state-${mode}`;
}

/**
 * Return the last non-property hash stored in our `appHistory` (or null).
 */
function getLastNonPropertyHash() {
    for (let i = appHistory.length - 1; i >= 0; i--) {
        const h = appHistory[i] || '';
        if (!h.startsWith('#property/')) return h || null;
    }
    return null;
}

/**
 * Estimate the full width of the right-side property panel based on
 * the current layout. When the panel is visible we measure it directly;
 * otherwise we approximate using the CSS clamp in --right-panel-width.
 */
function getRightPanelTargetWidth() {
    try {
        if (window.innerWidth < 768) return 0;
        if (rightSheet) {
            const rect = rightSheet.getBoundingClientRect();
            if (rect && rect.width) return rect.width;
        }
        const vwWidth = window.innerWidth * 0.24;
        return Math.min(480, Math.max(320, vwWidth));
    } catch (e) { }
    return 0;
}

/**
 * Returns half the width (in pixels) of the right-side property panel
 * (real or approximated) so we can offset map centering and land
 * between the left navigation panel and the overlay on the right.
 * Optional `scale` lets specific callers nudge slightly more/less.
 */
function getRightPanelHalfOffsetPx(scale = 1) {
    try {
        if (window.innerWidth < 768) return 0;
        const width = getRightPanelTargetWidth();
        if (!width) return 0;
        const safeScale = (typeof scale === 'number' && scale > 0) ? scale : 1;
        return Math.round((width / 2) * RIGHT_PANEL_OFFSET_MULTIPLIER * safeScale);
    } catch (e) { }
    return 0;
}

/**
 * Set the map view but nudge the target left by half the right panel
 * width when the right panel is open on desktop so the point appears
 * centered in the visible region between left and right panels.
 */
function smartSetView(latlng, zoom, options) {
    try {
        const targetZoom = (typeof zoom !== 'undefined' && zoom !== null) ? zoom : map.getZoom();
        const offsetX = getRightPanelHalfOffsetPx();

        if (offsetX && map && latlng) {
            // Calculate using project/unproject at the TARGET zoom level
            // This avoids the issue where calculating at current zoom (e.g. 13) 
            // and applying to new zoom (e.g. 15) results in a massive shift.

            // 1. Get global pixel coordinates of the target latlng at target zoom
            const targetPoint = map.project(latlng, targetZoom);

            // 2. We want the map center to be shifted by offsetX relative to the target
            // If we want target to be Left of center, Center must be Right of target.
            // So we add offsetX to the target's x-coordinate.
            // Note: offsetX is positive for right panel.
            const newCenterPoint = targetPoint.add([offsetX, 0]);

            // 3. Convert back to latlng
            const newCenterLatLng = map.unproject(newCenterPoint, targetZoom);

            map.setView(newCenterLatLng, targetZoom, options);
            return;
        }
    } catch (e) {
        console.debug('smartSetView error', e);
    }
    // Fallback: plain setView
    if (typeof zoom !== 'undefined' && zoom !== null) map.setView(latlng, zoom, options);
    else map.setView(latlng, map.getZoom(), options);
}

/**
 * Navigate to the home/hash="#" while emitting a lightweight stack trace
 * so we can diagnose unexpected callers that send the app back to the
 * main view. Use this instead of assigning `window.location.hash = '#'`
 * directly when we want traceability.
 */
function navigateHomeWithTrace(note) {
    try {
        if (note) console.warn('[TRACE] navigateHomeWithTrace:', note);
        // Print a stack trace to help identify the caller path in user repros
        console.trace('[TRACE] navigateHomeWithTrace stack');
    } catch (e) { }
    try { window.location.hash = '#'; } catch (e) { }
}

/**
 * Navigate to a named panel and adjust the map view appropriately.
 * Supports: `#districts`, `#landmarks`, `#survey`.
 */
function navigateToPanel(panelHash) {
    try {
        if (!panelHash || typeof panelHash !== 'string') return;
        // Normalize
        const h = panelHash.startsWith('#') ? panelHash : `#${panelHash}`;

        // Perform map adjustments for known panels BEFORE updating hash
        // so the map animation runs while the panel is settling.
        if (h === '#districts') {
            try {
                // Ensure districts layer is shown
                showDistrictsLayer();
                setDistrictLayerOpacity(0.6);
                // Compute bounds for all districts and fit
                if (allDistricts && allDistricts.length > 0) {
                    const fc = { type: 'FeatureCollection', features: allDistricts };
                    try {
                        const bounds = L.geoJSON(fc).getBounds();
                        if (bounds && bounds.isValid && bounds.isValid()) {
                            const rightHalf = getRightPanelHalfOffsetPx();
                            const padBR = [40 + rightHalf, 40];
                            map.fitBounds(bounds, { paddingTopLeft: [40, 40], paddingBottomRight: padBR });
                        }
                    } catch (e) {
                        // Fallback: center default
                        smartSetView([41.71, -87.67], 13);
                    }
                } else {
                    smartSetView([41.71, -87.67], 13);
                }
            } catch (e) { console.debug('navigateToPanel(#districts) map adjust error', e); }
        } else if (h === '#landmarks') {
            try {
                // Fit to all individual landmarks if any, otherwise to survey bounds
                const lm = surveyData && surveyData.features ? surveyData.features.filter(f => {
                    const v = f && f.properties && f.properties.individual_landmark;
                    return v && (String(v).trim().toUpperCase() === 'Y' || String(v).trim().toUpperCase() === 'YES');
                }) : [];
                let bounds = null;
                if (lm.length > 0) bounds = L.geoJSON({ type: 'FeatureCollection', features: lm }).getBounds();
                else if (surveyData && surveyData.features && surveyData.features.length > 0) bounds = L.geoJSON(surveyData).getBounds();
                if (bounds && bounds.isValid && bounds.isValid()) {
                    const rightHalf = getRightPanelHalfOffsetPx();
                    const padBR = [40 + rightHalf, 40];
                    map.fitBounds(bounds, { paddingTopLeft: [40, 40], paddingBottomRight: padBR });
                } else {
                    smartSetView([41.71, -87.67], 13);
                }
            } catch (e) { console.debug('navigateToPanel(#landmarks) map adjust error', e); }
        } else if (h === '#survey') {
            try { smartSetView([41.71, -87.675], 15); } catch (e) { }
        }

        // Finally, set the hash to change the panel. This will also get
        // picked up by the router logic which may perform additional work.
        try { window.location.hash = h; } catch (e) { console.debug('navigateToPanel set hash error', e); }
    } catch (e) {
        console.debug('navigateToPanel error', e);
    }
}

/**
 * Renders search results for the welcome panel dropdown
 */
function renderWelcomeSearchResults(results, dropdown, input) {
    if (!results || results.length === 0) {
        dropdown.style.display = 'none';
        return;
    }

    const listHtml = results.map(f => {
        const address = formatAddress(f.properties);
        return `<div class="search-result-item" data-id="${f.properties.BLDG_ID}" style="padding: 10px 12px; cursor: pointer; border-bottom: 1px solid #eee; font-size: 15px; color: #333;">${address}</div>`;
    }).join('');

    dropdown.innerHTML = listHtml;
    dropdown.style.display = 'block';

    // Add click listeners
    dropdown.querySelectorAll('.search-result-item').forEach(item => {
        item.addEventListener('click', (e) => {
            e.stopPropagation(); // Prevent bubbling
            const id = item.dataset.id;
            attemptShowProperty(id);
            dropdown.style.display = 'none';
            input.value = '';
        });
    });
}