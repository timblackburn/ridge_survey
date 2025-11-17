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
let locationMarker = null; // For the "you are here" dot

// Tracks the "Follow map" toggle state
let isMapFollowEnabled = false;

// Tracks the location button state
let locationMode = 'off'; // 'off', 'following', 'error'

// Get references to key DOM elements
let appContainer, bottomSheet, sheetContent, sheetHandle, searchInput, 
    locationButton, filterPillsContainer, searchResultsDropdown;

// Loading flag
let isDataLoaded = false;
let currentDropdownResults = []; // For "Enter" key logic
let appHistory = []; // For custom history tracking

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

// Initialize the map
const map = L.map('map', {
    zoomControl: false,
    scrollWheelZoom: true
}).setView([41.71, -87.67], 13);

L.control.zoom({ position: 'topright' }).addTo(map);

L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png', {
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, © <a href="https://carto.com/attributions">CARTO</a>'
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

    // Move pills to side panel on desktop load
    handleResize(); 

    showDefaultPanel();
    setupEventListeners();
    loadDataSources();
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
        
        // Process districts to "cut holes"
        let processedNationalFeatures = nationalDistricts.features;
        
        for (const localFeature of chicagoDistricts.features) {
            let newProcessedFeatures = []; 
            
            for (const nationalFeature of processedNationalFeatures) {
                if (!nationalFeature || !nationalFeature.geometry) {
                    continue; 
                }
                
                try {
                    const cutFeature = turf.difference(nationalFeature, localFeature);
                    if (cutFeature) {
                        cutFeature.properties = nationalFeature.properties;
                        newProcessedFeatures.push(cutFeature);
                    }
                } catch (e) {
                    console.warn("Turf.difference failed, keeping original:", e);
                    newProcessedFeatures.push(nationalFeature);
                }
            }
            processedNationalFeatures = newProcessedFeatures;
        }
        
        allDistricts = [ ...processedNationalFeatures, ...chicagoDistricts.features ];

        // Pre-process survey data (for decades)
        preprocessSurveyData();
        
        console.log("Data loaded and pre-processed");

        nationalDistrictsLayer = L.geoJSON({ type: 'FeatureCollection', features: processedNationalFeatures }, {
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
                layer.on('click', () => {
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

    // Main hash change router
    window.addEventListener('hashchange', handleHashChange);
    
    // Listen for screen resize to move UI elements
    window.addEventListener('resize', handleResize);

    // Pill clicks
    document.querySelectorAll('#filter-pills .pill').forEach(pill => {
        pill.addEventListener('click', (e) => {
            const filter = e.currentTarget.dataset.filter;
            let currentHash = window.location.hash;
            
            if (filter === 'districts' && currentHash === '#districts') {
                window.location.hash = '#';
            } else if (filter === 'landmarks' && currentHash === '#landmarks') {
                window.location.hash = '#';
            } else if (filter === 'survey' && currentHash.startsWith('#survey')) {
                window.location.hash = '#';
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
                // If one result, go to it
                window.location.hash = `#property/${currentDropdownResults[0].properties.BLDG_ID}`;
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
        if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
        clickTimer = setTimeout(() => {
            // Check if the click was on the map proper, not a control
            const targetClass = e.originalEvent.target.classList;
            if (targetClass.contains('leaflet-container') || targetClass.contains('leaflet-tile')) {
                window.location.hash = '#';
            }
            clickTimer = null;
        }, 250); 
    });

    // Map double-click handler
    map.on('dblclick', (e) => {
        if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
    });


    // *** MODIFIED: Delegated listener attached to the panel itself ***
    bottomSheet.addEventListener('click', function(e) {
        // Follow map toggle
        if (e.target.id === 'follow-map-toggle') {
            isMapFollowEnabled = !isMapFollowEnabled;
            handleHashChange(); 
        }
        
        // Back button
        if (e.target.classList.contains('back-button')) {
            window.location.hash = '#';
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
                window.location.hash = '#';
            }
        }

        // List item clicks
        const li = e.target.closest('li');
        if (li) {
            if (li.dataset.name) window.location.hash = `#district/${encodeURIComponent(li.dataset.name)}`;
            if (li.dataset.id) window.location.hash = `#property/${li.dataset.id}`;
            if (li.dataset.hash) window.location.hash = `#${li.dataset.hash}`;
            if (li.dataset.color) window.location.hash = `#survey/color/${encodeURIComponent(li.dataset.color)}`;
            if (li.dataset.decade) window.location.hash = `#survey/decade/${encodeURIComponent(li.dataset.decade)}`;
            if (li.dataset.architect) window.location.hash = `#survey/architect/${encodeURIComponent(li.dataset.architect)}`;
            if (li.dataset.style) window.location.hash = `#survey/style/${encodeURIComponent(li.dataset.style)}`;
        }
    });

    // Map move listener (for "Follow map")
    map.on('moveend', () => {
        if (isMapFollowEnabled && bottomSheet.classList.contains('expanded')) {
            handleHashChange();
        }
    });

    // Location button and map event listeners
    locationButton.addEventListener('click', handleLocationClick);
    map.on('dragstart', disableLocation);
    map.on('locationfound', handleLocationFound);
    map.on('locationerror', handleLocationError);
}

// ---------------------------------------------------------------
//  3. ROUTER - Reads the URL hash and controls the app
// ---------------------------------------------------------------

function handleHashChange() {
    if (!isDataLoaded) return;
    
    const hash = window.location.hash;

    // Push to our custom history tracker, avoiding duplicates.
    if (appHistory.length === 0 || appHistory[appHistory.length - 1] !== hash) {
        appHistory.push(hash);
    }
    
    // Clear highlights and popups
    clearBuildingHighlight();
    clearDistrictHighlight(); 
    clearSearchDropdown();
    
    // *** FIX: Always remove property view class on nav ***
    bottomSheet.classList.remove('property-view-active');

    if (hash.startsWith('#property/')) {
        const bldgId = parseInt(hash.split('/')[1], 10);
        const feature = surveyData.features.find(f => f.properties.BLDG_ID === bldgId);
        if (feature) {
            highlightBuilding(feature);
            buildPropertyCard(feature.properties);
            zoomToFeature(feature, 18);
        }
        hideDistrictsLayer();

    } else if (hash.startsWith('#district/')) {
        const districtName = decodeURIComponent(hash.split('/')[1]);
        const feature = allDistricts.find(f => f.properties.NAME === districtName);
        if (feature) {
            highlightDistrict(feature);
            buildDistrictDetailsPanel(feature);
            zoomToFeature(feature);
        }
    } else if (hash.startsWith('#search/')) {
        const query = decodeURIComponent(hash.split('/')[1]);
        if (searchInput.value !== query) {
            map.setView([41.71, -87.67], 13);
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

    } else if (hash === '#districts') {
        buildDistrictsPanel();
        updateActivePill('districts');
        showDistrictsLayer();
        setDistrictLayerOpacity(0.6);
        updateSurveyLayer('default');

    } else if (hash.startsWith('#survey')) {
        hideDistrictsLayer();
        updateActivePill('survey');
        
        if (hash === '#survey') {
            buildSurveyPanel();
            updateSurveyLayer('default');
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
        updateActivePill(null);
        updateSurveyLayer('default');
        showDistrictsLayer();
        setDistrictLayerOpacity(0.6);
        // *** FIX: Correctly toggle panel based on screen size ***
        if (window.innerWidth < 768) {
            toggleBottomSheet(false); // Close mobile panel
        } else {
            toggleBottomSheet(true); // Ensure desktop panel is open
        }
    }
}

// ---------------------------------------------------------------
//  4. PANEL-BUILDING FUNCTIONS
// ---------------------------------------------------------------

// --- MAIN LISTS ---

function buildDistrictsPanel() {
    let filteredDistricts = allDistricts;
    if (isMapFollowEnabled) {
        const mapBounds = map.getBounds();
        filteredDistricts = allDistricts.filter(feature => {
            try { return L.geoJSON(feature).getBounds().intersects(mapBounds); } 
            catch (e) { return false; }
        });
    }
    filteredDistricts.sort((a, b) => a.properties.NAME.localeCompare(b.properties.NAME));
    
    let listHtml = filteredDistricts.map(f => {
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

    const followToggleHtml = `<button id="follow-map-toggle" class="pill ${isMapFollowEnabled ? 'active' : ''}">Follow map</button>`;

    sheetContent.innerHTML = `
        <div class="sheet-header">
            <h3><button class="back-button">&larr;</button>Historic Districts</h3>
            ${followToggleHtml}
        </div>
        <div class="scrollable-content"><ul class="item-list">${listHtml}</ul></div>
    `;
    toggleBottomSheet(true);
}

function buildLandmarksPanel() {
    const allLandmarks = surveyData.features.filter(f => {
        const value = f.properties.individual_landmark;
        return value && (String(value).trim().toUpperCase() === 'Y' || String(value).trim().toUpperCase() === 'YES');
    });

    let filteredLandmarks = allLandmarks;
    if (isMapFollowEnabled) {
        const featuresInView = getFeaturesInView();
        const inViewIds = new Set(featuresInView.map(f => f.properties.BLDG_ID));
        filteredLandmarks = allLandmarks.filter(f => inViewIds.has(f.properties.BLDG_ID));
    }
    
    filteredLandmarks.sort(propertySort);

    let listHtml;
    if (filteredLandmarks.length === 0) {
        listHtml = (isMapFollowEnabled && allLandmarks.length > 0) ? '<p>No landmarks found in this map view.</p>' : '<p>No individual landmarks found in survey data.</p>';
    } else {
        listHtml = `<ul class="item-list">${filteredLandmarks.map(f => `<li data-id="${f.properties.BLDG_ID}"><a>${formatAddress(f.properties)}</a></li>`).join('')}</ul>`;
    }

    const followToggleHtml = `<button id="follow-map-toggle" class="pill ${isMapFollowEnabled ? 'active' : ''}">Follow map</button>`;
    sheetContent.innerHTML = `
        <div class="sheet-header">
            <h3>Individual Landmarks</h3>
            ${followToggleHtml}
        </div>
        <div class="scrollable-content">${listHtml}</div>
    `;
    toggleBottomSheet(true);
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
        const feature = results[0];
        window.location.hash = `#property/${feature.properties.BLDG_ID}`;
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

    let listHtml = filteredResults.length === 0 ? '<p>No matching properties found.</p>' : 
        `<ul class="item-list">${filteredResults.map(f => `<li data-id="${f.properties.BLDG_ID}"><a>${formatAddress(f.properties)}</a></li>`).join('')}</ul>`;

    const followToggleHtml = `<button id="follow-map-toggle" class="pill ${isMapFollowEnabled ? 'active' : ''}">Follow map</button>`;
    sheetContent.innerHTML = `
        <div class="sheet-header">
            <h3>Search Results (${filteredResults.length})</h3>
            ${followToggleHtml}
        </div>
        <div class="scrollable-content">${listHtml}</div>
    `;

    toggleBottomSheet(true);
}

// --- SURVEY SUB-PANELS ---

function buildSurveyPanel() {
    sheetContent.innerHTML = `
        <div class="sheet-header"><h3>Building Survey</h3></div>
        <div class="scrollable-content">
            <ul class="item-list">
                <li data-hash="survey/color"><a>Color Code</a></li>
                <li data-hash="survey/decade"><a>Decade Built</a></li>
                <li data-hash="survey/architect"><a>Architect</a></li>
                <li data-hash="survey/style"><a>Building Style</a></li>
            </ul>
        </div>
    `;
    toggleBottomSheet(true);
}

function buildColorCodeListPanel() {
    const features = isMapFollowEnabled ? getFeaturesInView() : surveyData.features;
    const colorCounts = {};
    features.forEach(f => {
        const color = f.properties.CHRS_Color;
        if (color) colorCounts[color] = (colorCounts[color] || 0) + 1;
    });

    let listHtml = Object.keys(colorCounts).sort().map(color => `
        <li data-color="${color}">
            <a>
                <span class="color-swatch" style="background-color: ${color.toLowerCase()}"></span>
                ${color} (${colorCounts[color]})
            </a>
        </li>
    `).join('');

    const followToggleHtml = `<button id="follow-map-toggle" class="pill ${isMapFollowEnabled ? 'active' : ''}">Follow map</button>`;
    sheetContent.innerHTML = `
        <div class="sheet-header">
            <h3><button class="back-button">&larr;</button>Color Code</h3>
            ${followToggleHtml}
        </div>
        <div class="scrollable-content"><ul class="item-list">${listHtml}</ul></div>
    `;
    toggleBottomSheet(true);
}

function buildDecadeListPanel() {
    const features = isMapFollowEnabled ? getFeaturesInView() : surveyData.features;
    const decadeCounts = {};
    features.forEach(f => {
        const decade = f.properties.decade; // Relies on preprocess
        if (decade) decadeCounts[decade] = (decadeCounts[decade] || 0) + 1;
    });

    let listHtml = Object.keys(decadeCounts).sort().map(decade => {
        const color = stringToColor(decade);
        return `
        <li data-decade="${decade}">
            <a>
                <span class="color-swatch" style="background-color: ${color}"></span>
                ${decade} (${decadeCounts[decade]})
            </a>
        </li>
    `}).join('');

    const followToggleHtml = `<button id="follow-map-toggle" class="pill ${isMapFollowEnabled ? 'active' : ''}">Follow map</button>`;
    sheetContent.innerHTML = `
        <div class="sheet-header">
            <h3><button class="back-button">&larr;</button>Decade Built</h3>
            ${followToggleHtml}
        </div>
        <div class="scrollable-content"><ul class="item-list">${listHtml}</ul></div>
    `;
    toggleBottomSheet(true);
}

function buildArchitectListPanel() {
    const features = isMapFollowEnabled ? getFeaturesInView() : surveyData.features;
    const architectCounts = {};
    features.forEach(f => {
        const architect = f.properties.CHRS_Architect;
        if (architect) architectCounts[architect] = (architectCounts[architect] || 0) + 1;
    });

    let listHtml = Object.keys(architectCounts).sort().map(architect => {
        const color = stringToColor(architect);
        return `
        <li data-architect="${architect}">
            <a>
                <span class="color-swatch" style="background-color: ${color}"></span>
                ${architect} (${architectCounts[architect]})
            </a>
        </li>
    `}).join('');

    const followToggleHtml = `<button id="follow-map-toggle" class="pill ${isMapFollowEnabled ? 'active' : ''}">Follow map</button>`;
    sheetContent.innerHTML = `
        <div class="sheet-header">
            <h3><button class="back-button">&larr;</button>Architect</h3>
            ${followToggleHtml}
        </div>
        <div class="scrollable-content"><ul class="item-list">${listHtml}</ul></div>
    `;
    toggleBottomSheet(true);
}

function buildStyleListPanel() {
    const features = isMapFollowEnabled ? getFeaturesInView() : surveyData.features;
    const styleCounts = {};
    features.forEach(f => {
        const style = f.properties["CHRS_Building Style"];
        if (style) styleCounts[style] = (styleCounts[style] || 0) + 1;
    });

    let listHtml = Object.keys(styleCounts).sort().map(style => {
        const color = stringToColor(style);
        return `
        <li data-style="${style}">
            <a>
                <span class="color-swatch" style="background-color: ${color}"></span>
                ${style} (${styleCounts[style]})
            </a>
        </li>
    `}).join('');

    const followToggleHtml = `<button id="follow-map-toggle" class="pill ${isMapFollowEnabled ? 'active' : ''}">Follow map</button>`;
    sheetContent.innerHTML = `
        <div class="sheet-header">
            <h3><button class="back-button">&larr;</button>Building Style</h3>
            ${followToggleHtml}
        </div>
        <div class="scrollable-content"><ul class="item-list">${listHtml}</ul></div>
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
    let listHtml = filteredFeatures.map(f => `<li data-id="${f.properties.BLDG_ID}"><a>${formatAddress(f.properties)}</a></li>`).join('');

    const followToggleHtml = `<button id="follow-map-toggle" class="pill ${isMapFollowEnabled ? 'active' : ''}">Follow map</button>`;
    sheetContent.innerHTML = `
        <div class="sheet-header">
            <h3><button class="back-button">&larr;</button>${color} (${filteredFeatures.length})</h3>
            ${followToggleHtml}
        </div>
        <div class="scrollable-content"><ul class="item-list">${listHtml}</ul></div>
    `;
    toggleBottomSheet(true);
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
    let listHtml = filteredFeatures.map(f => `<li data-id="${f.properties.BLDG_ID}"><a>${formatAddress(f.properties)}</a></li>`).join('');

    const followToggleHtml = `<button id="follow-map-toggle" class="pill ${isMapFollowEnabled ? 'active' : ''}">Follow map</button>`;
    sheetContent.innerHTML = `
        <div class="sheet-header">
            <h3><button class="back-button">&larr;</button>${decade} (${filteredFeatures.length})</h3>
            ${followToggleHtml}
        </div>
        <div class="scrollable-content"><ul class="item-list">${listHtml}</ul></div>
    `;
    toggleBottomSheet(true);
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
    let listHtml = filteredFeatures.map(f => `<li data-id="${f.properties.BLDG_ID}"><a>${formatAddress(f.properties)}</a></li>`).join('');

    const followToggleHtml = `<button id="follow-map-toggle" class="pill ${isMapFollowEnabled ? 'active' : ''}">Follow map</button>`;
    sheetContent.innerHTML = `
        <div class="sheet-header">
            <h3><button class="back-button">&larr;</button>${architect} (${filteredFeatures.length})</h3>
            ${followToggleHtml}
        </div>
        <div class="scrollable-content"><ul class="item-list">${listHtml}</ul></div>
    `;
    toggleBottomSheet(true);
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
    let listHtml = filteredFeatures.map(f => `<li data-id="${f.properties.BLDG_ID}"><a>${formatAddress(f.properties)}</a></li>`).join('');

    const followToggleHtml = `<button id="follow-map-toggle" class="pill ${isMapFollowEnabled ? 'active' : ''}">Follow map</button>`;
    sheetContent.innerHTML = `
        <div class="sheet-header">
            <h3><button class="back-button">&larr;</button>${style} (${filteredFeatures.length})</h3>
            ${followToggleHtml}
        </div>
        <div class="scrollable-content"><ul class="item-list">${listHtml}</ul></div>
    `;
    toggleBottomSheet(true);
}


// --- DISTRICT & PROPERTY PANELS ---

function buildDistrictDetailsPanel(districtFeature) {
    const districtName = districtFeature.properties.NAME;
    const districtGeom = districtFeature.geometry;

    const propertiesInside = surveyData.features.filter(propFeature => {
        const propGeom = propFeature.geometry;
        if (!propGeom) return false;
        try {
            const center = turf.centroid(propFeature);
            return turf.booleanPointInPolygon(center, districtGeom);
        } catch (e) { return false; }
    });
    
    let filteredProperties = propertiesInside;
    if (isMapFollowEnabled) {
        const featuresInView = getFeaturesInView();
        const inViewIds = new Set(featuresInView.map(f => f.properties.BLDG_ID));
        filteredProperties = propertiesInside.filter(f => inViewIds.has(f.properties.BLDG_ID));
    }
    
    filteredProperties.sort(propertySort);

    let listHtml = filteredProperties.length === 0 ? '<p>No properties from the survey found in this district.</p>' :
        `<ul class="item-list">${filteredProperties.map(f => `<li data-id="${f.properties.BLDG_ID}"><a>${formatAddress(f.properties)}</a></li>`).join('')}</ul>`;

    const followToggleHtml = `<button id="follow-map-toggle" class="pill ${isMapFollowEnabled ? 'active' : ''}">Follow map</button>`;
    sheetContent.innerHTML = `
        <div class="sheet-header">
            <h3><button class="back-button">&larr;</button>${districtName}</h3>
            ${followToggleHtml}
        </div>
        <div class="scrollable-content"><ul class="item-list">${listHtml}</ul></div>
    `;
    toggleBottomSheet(true);
}

function buildPropertyCard(props) {
    const address = formatAddress(props);
    const val = (field) => field || 'N/A';

    sheetContent.innerHTML = `
        <button class="close-property-button">&times;</button>
        <div class="scrollable-content">
            <div class="sheet-header" style="padding-top: 5px;">
                <h3>${address}</h3>
            </div>
            <div class="property-card">
                <div class="prop-grid">
                    <div><strong>Year Built:</strong> ${val(props.YEAR_BUILT)}</div>
                    <div><strong>Stories:</strong> ${val(props.STORIES)}</div>
                    <div><strong>Architect:</strong> ${val(props.CHRS_Architect)}</div>
                    <div><strong>Style:</strong> ${val(props["CHRS_Building Style"])}</div>
                    <div><strong>Landmark:</strong> ${val(props.individual_landmark) === 'Y' || String(val(props.individual_landmark)).trim().toUpperCase() === 'YES' ? 'Yes' : 'No'}</div>
                </div>
                <p class="prop-note">Data from Chicago Historic Resources Survey (CHRS) and local survey.</p>
            </div>
        </div>
    `;
    
    bottomSheet.classList.add('property-view-active');
    toggleBottomSheet(true);
}


// ---------------------------------------------------------------
//  5. HELPER FUNCTIONS
// ---------------------------------------------------------------

/**
 * Sets the panel to its default "Explore" state.
 */
function showDefaultPanel() {
    sheetContent.innerHTML = `
        <div class="sheet-header"><h3>Explore the Survey</h3></div>
        <div class="scrollable-content">
            <p>Select a building, search for an address, or browse by category.</p>
        </div>
    `;
}

/**
 * Search Dropdown Functions
 */
function showSearchDropdown(query) {
    if (!query || query.length < 2) {
        clearSearchDropdown();
        return;
    }

    const searchQuery = query.toLowerCase().trim();
    const results = surveyData.features.filter(f => {
        const address = formatAddress(f.properties).toLowerCase();
        return address.includes(searchQuery);
    }).slice(0, 5); // Show top 5 results

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
            window.location.hash = `#property/${li.dataset.id}`;
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
    if (selectedDistrictLayer) {
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
    clearDistrictHighlight(); 
    hideDistrictsLayer(); // Hide the main layer
    
    const color = getDistrictColor(feature.properties.NAME);
    
    selectedDistrictLayer = L.geoJSON(feature, {
        style: { color: color, weight: 3, fillColor: color, fillOpacity: 0.5 },
        interactive: false,
        pane: 'selectedDistrictPane'
    }).addTo(map);
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
function zoomToFeature(feature, maxZoom = null) {
    const bounds = turf.bbox(feature);
    let options = {};

    if (window.innerWidth < 768) {
        // Mobile: 45vh bottom panel
        const panelHeight = map.getSize().y * 0.45; 
        options = { 
            paddingTopLeft: [40, 40], 
            paddingBottomRight: [40, panelHeight + 20] 
        };
    } else {
        // Desktop: 400px side panel
        options = { 
            paddingTopLeft: [40, 420], // 400px panel + 20px padding
            paddingBottomRight: [40, 40] 
        };
    }
    
    if (maxZoom) {
        options.maxZoom = maxZoom;
    }
    
    map.fitBounds([[bounds[1], bounds[0]], [bounds[3], bounds[2]]], options);
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

    if (mode === 'color') {
        styleFunc = (feature) => {
            const color = feature.properties.CHRS_Color;
            if (color) {
                return {
                    fillColor: color.toLowerCase(), fillOpacity: 0.6,
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
                    fillColor: stringToColor(decade), fillOpacity: 0.6,
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
    const mapBounds = map.getBounds();
    return surveyData.features.filter(f => {
        try {
            // Use polygon centroid for bounds check
            const center = turf.centroid(f);
            const latLng = L.latLng(center.geometry.coordinates[1], center.geometry.coordinates[0]);
            return mapBounds.contains(latLng);
        } catch (e) {
            // turf.centroid can fail on invalid geometries
            return false;
        }
    });
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
    });
}

/**
 * Main click handler for the location button
 */
function handleLocationClick() {
    if (locationMode === 'off' || locationMode === 'error') {
        map.locate({
            watch: true,
            setView: true,
            maxZoom: 17
        });
        setLocationMode('following');
    } else {
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
        map.setView(e.latlng, map.getZoom() || 17);
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