// Initialize map
const vectorSource = new ol.source.Vector();
const vectorLayer = new ol.layer.Vector({
    source: vectorSource,
    style: styleFunction,
});

const map = new ol.Map({
    target: 'map',
    layers: [
        new ol.layer.Tile({
            source: new ol.source.XYZ({
                url: 'https://{1-4}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
                attributions: '© OpenStreetMap contributors, © Carto'
            })
        }),
        vectorLayer,
    ],
    view: new ol.View({
        center: ol.proj.fromLonLat([69.3451, 30.3753]), // Center on Pakistan
        zoom: 6,
    }),
});

// Create truck icon styles for different statuses
const truckStyles = {
    moving: createTruckStyle('#28a745'), // Green for moving
    idle: createTruckStyle('#ffc107'),   // Yellow for idle
    stopped: createTruckStyle('#dc3545') // Red for stopped
};

// Create truck icon style with given color
function createTruckStyle(color) {
    const canvas = document.createElement('canvas');
    const size = 24;
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    
    // Draw truck body
    ctx.fillStyle = color;
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1;
    
    // Cab
    ctx.fillRect(2, 8, 7, 8);
    ctx.strokeRect(2, 8, 7, 8);
    
    // Trailer
    ctx.fillRect(9, 6, 13, 12);
    ctx.strokeRect(9, 6, 13, 12);
    
    // Wheels
    ctx.fillStyle = '#000';
    ctx.beginPath();
    ctx.arc(5, 16, 2, 0, Math.PI * 2);
    ctx.arc(14, 18, 2, 0, Math.PI * 2);
    ctx.arc(20, 18, 2, 0, Math.PI * 2);
    ctx.fill();
    
    return new ol.style.Icon({
        img: canvas,
        imgSize: [size, size],
        anchor: [0.5, 0.5],
        scale: 1
    });
}

// Update the style function to handle feature styling better
function styleFunction(feature) {
    const status = feature.get('status') || 'moving'; // Default to moving if no status
    console.log('Styling feature:', feature.get('id'), 'status:', status); // Debug log
    return new ol.style.Style({
        image: truckStyles[status] || truckStyles.moving // Fallback to moving style if status not found
    });
}

// Worker setup
const worker = new Worker('worker.js');

// State
const filters = { 
    status: { moving: true, idle: true, stopped: true },
    vehicle: '',
    dateFrom: '',
    dateTo: ''
};
let allFeatures = [];
let counts = { moving: 0, idle: 0, stopped: 0, total: 0 };

// WebSocket setup with reconnection logic
let ws;
let reconnectAttempts = 0;
const maxReconnectAttempts = 5;
const reconnectDelay = 3000;

function connectWebSocket() {
    ws = new WebSocket(CONFIG.wsUrl);
    
    // Update WebSocket message handler
    ws.onmessage = e => {
        console.log('WebSocket message received'); // Debug log
        const geo = JSON.parse(e.data);
        console.log('Received features:', geo.features.length); // Debug log
        allFeatures = geo.features;
        
        // Extract vehicle IDs and update counts
        extractVehicleIds();
        
        if (geo.counts) {
            counts = geo.counts;
            counts.total = counts.moving + counts.idle + counts.stopped;
            console.log('Vehicle counts:', counts); // Debug log
        }
        
        // Clear existing features
        vectorSource.clear();
        
        // Add new features to the map
        geo.features.forEach(feature => {
            const olFeature = new ol.Feature({
                geometry: new ol.geom.Point(ol.proj.fromLonLat(feature.geometry.coordinates))
            });
            
            // Set feature properties
            olFeature.set('status', feature.properties.status);
            olFeature.set('id', feature.properties.id);
            olFeature.set('timestamp', feature.properties.timestamp);
            olFeature.set('last_update', feature.properties.last_update);
            
            vectorSource.addFeature(olFeature);
        });
        
        // Update KPIs and UI
        updateFilteredFeatures();
        document.getElementById('last-update').textContent = new Date().toLocaleTimeString();
    };

    ws.onclose = () => {
        if (reconnectAttempts < maxReconnectAttempts) {
            console.log(`WebSocket closed. Reconnecting in ${reconnectDelay}ms...`);
            setTimeout(connectWebSocket, reconnectDelay);
            reconnectAttempts++;
        } else {
            console.error('WebSocket connection failed after maximum attempts');
        }
    };

    // Improve error handling for WebSocket
    ws.onerror = (error) => {
        console.error('WebSocket error:', error);
        const connectionError = document.getElementById('connectionError');
        if (connectionError) {
            const modal = new bootstrap.Modal(connectionError);
            modal.show();
        }
    };

    ws.onopen = () => {
        console.log('WebSocket connected');
        reconnectAttempts = 0;
        // Send initial filters if any are set
        sendFilters();
    };
}

// Send filter settings to the server
function sendFilters() {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            filters: {
                car: filters.vehicle,
                dateFrom: filters.dateFrom,
                dateTo: filters.dateTo
            }
        }));
    }
}

connectWebSocket();

// Update filtered features and KPIs
function updateFilteredFeatures() {
    // Apply status filters
    const filteredFeatures = allFeatures.filter(f => {
        // Filter by status
        if (!filters.status[f.properties.status]) return false;
        
        // Filter by vehicle ID if specified
        if (filters.vehicle && !f.properties.id.toLowerCase().includes(filters.vehicle.toLowerCase())) {
            return false;
        }
        
        return true;
    });
    
    // Update the worker with filtered features
    worker.postMessage({ type: 'seed', payload: filteredFeatures });
    updateKPIs(filteredFeatures);
    queryClusters();
}

// Update KPI cards based on filtered features
function updateKPIs(filteredFeatures) {
    // Count filtered features by status
    const filteredCounts = { moving: 0, idle: 0, stopped: 0, total: 0 };
    
    filteredFeatures.forEach(f => {
        const status = f.properties.status;
        filteredCounts[status]++;
        filteredCounts.total++;
    });
    
    // Update KPI elements
    document.getElementById('total-kpi').textContent = filteredCounts.total;
    document.getElementById('moving-kpi').textContent = filteredCounts.moving;
    document.getElementById('idle-kpi').textContent = filteredCounts.idle;
    document.getElementById('stopped-kpi').textContent = filteredCounts.stopped;
    
    // Update count indicators next to checkboxes
    document.getElementById('moving-count').textContent = counts.moving;
    document.getElementById('idle-count').textContent = counts.idle;
    document.getElementById('stopped-count').textContent = counts.stopped;
}

// Query clusters
function queryClusters() {
    const extent = map.getView().calculateExtent(map.getSize());
    const bbox = ol.proj.transformExtent(extent, 'EPSG:3857', 'EPSG:4326');
    const zoom = Math.round(map.getView().getZoom());
    worker.postMessage({ type: 'query', payload: { bbox, zoom } });
}

// Handle worker messages
worker.onmessage = ({ data: trucks }) => {
    vectorSource.clear();
    trucks.forEach(t => {
        const f = new ol.Feature({
            geometry: new ol.geom.Point(ol.proj.fromLonLat(t.geometry.coordinates))
        });
        
        // Set feature properties
        f.set('status', t.properties.status);
        f.set('id', t.properties.id);
        
        // Add timestamp and other properties if available
        if (t.properties.timestamp) {
            f.set('timestamp', t.properties.timestamp);
        }
        if (t.properties.last_update) {
            f.set('last_update', t.properties.last_update);
        }
        if (t.properties.date) {
            f.set('date', t.properties.date);
        }
        
        // Add to source
        vectorSource.addFeature(f);
    });
};

// Add popup overlay to the map
const popup = new ol.Overlay({
    element: document.createElement('div'),
    positioning: 'bottom-center',
    offset: [0, -10],
    autoPan: true,
    autoPanAnimation: {
        duration: 250
    }
});
map.addOverlay(popup);

// Configure popup element
const popupElement = popup.getElement();
popupElement.className = 'ol-popup';
popupElement.innerHTML = `
    <div class="popup-content"></div>
    <button type="button" class="popup-closer">&times;</button>
`;

// Close popup on button click
const popupCloser = popupElement.querySelector('.popup-closer');
popupCloser.addEventListener('click', () => {
    popup.setPosition(undefined);
    popupCloser.blur();
    return false;
});

// Show popup on feature click
map.on('click', (e) => {
    const feature = map.forEachFeatureAtPixel(e.pixel, function(feature) {
        return feature;
    });
    
    if (feature) {
        const coords = feature.getGeometry().getCoordinates();
        const status = feature.get('status');
        const id = feature.get('id');
        const lastUpdate = feature.get('last_update') || 'Unknown';
        
        // Set popup content
        const popupContent = popupElement.querySelector('.popup-content');
        popupContent.innerHTML = `
            <h5>Vehicle: ${id}</h5>
            <p>Status: <span class="status-${status}">${status.toUpperCase()}</span></p>
            <p>Last Update: ${lastUpdate}</p>
        `;
        
        popup.setPosition(coords);
    }
});

// Status filter event listeners
['moving', 'idle', 'stopped'].forEach(status => {
    document.getElementById(`${status}-filter`).addEventListener('change', function() {
        filters.status[status] = this.checked;
        updateFilteredFeatures();
    });
});

// Global variables for vehicle selection
let allVehicles = [];
let selectedVehicles = [];

// Extract vehicle IDs from map data
function extractVehicleIds() {
    // If we have features loaded, extract vehicle IDs from them
    if (allFeatures && allFeatures.length > 0) {
        const vehicleIds = new Set(); // Use a Set to avoid duplicates
        
        allFeatures.forEach(feature => {
            if (feature.properties && feature.properties.id) {
                vehicleIds.add(feature.properties.id);
            }
        });
        
        // Convert Set to Array and sort
        allVehicles = Array.from(vehicleIds).sort();
        console.log(`Extracted ${allVehicles.length} vehicles from map data:`, allVehicles);
    } else {
        console.warn('No map features available to extract vehicle IDs');
        allVehicles = [];
    }
    
    // Populate the vehicle dropdown
    populateVehicleDropdown(allVehicles);
}

// Populate the vehicle dropdown
function populateVehicleDropdown(vehicles) {
    const vehicleDropdown = document.getElementById('vehicle-dropdown');
    
    // Clear existing options except the first one
    while (vehicleDropdown.options.length > 1) {
        vehicleDropdown.remove(1);
    }
    
    // Add all vehicles as options
    vehicles.forEach(vehicle => {
        const option = document.createElement('option');
        option.value = vehicle;
        option.textContent = vehicle;
        vehicleDropdown.appendChild(option);
    });
}

// Update the UI to show selected vehicles
function updateSelectedVehiclesUI() {
    const container = document.getElementById('selected-vehicles');
    
    if (selectedVehicles.length === 0) {
        container.innerHTML = 'No vehicles selected';
        return;
    }
    
    container.innerHTML = '';
    
    selectedVehicles.forEach(vehicle => {
        const tag = document.createElement('div');
        tag.className = 'selected-vehicle-tag';
        tag.innerHTML = `${vehicle} <span class="vehicle-tag-remove" data-vehicle="${vehicle}">&times;</span>`;
        container.appendChild(tag);
    });
    
    // Add event listeners to remove buttons
    const removeButtons = container.querySelectorAll('.vehicle-tag-remove');
    removeButtons.forEach(button => {
        button.addEventListener('click', function() {
            const vehicle = this.getAttribute('data-vehicle');
            removeSelectedVehicle(vehicle);
        });
    });
}

// Add a vehicle to the selected list
function addSelectedVehicle(vehicle) {
    if (!selectedVehicles.includes(vehicle)) {
        selectedVehicles.push(vehicle);
        updateSelectedVehiclesUI();
    }
}

// Remove a vehicle from the selected list
function removeSelectedVehicle(vehicle) {
    selectedVehicles = selectedVehicles.filter(v => v !== vehicle);
    updateSelectedVehiclesUI();
}

// Handle vehicle search functionality
document.getElementById('vehicle-search').addEventListener('input', function(e) {
    const searchTerm = e.target.value.trim().toLowerCase();
    
    if (searchTerm === '') {
        // If search is empty, show all vehicles
        populateVehicleDropdown(allVehicles);
        return;
    }
    
    // Filter vehicles based on search term
    const filteredVehicles = allVehicles.filter(vehicle => 
        vehicle.toLowerCase().includes(searchTerm)
    );
    
    // Update dropdown with filtered results
    populateVehicleDropdown(filteredVehicles);
});

// Handle dropdown selection
document.getElementById('vehicle-dropdown').addEventListener('change', function(e) {
    const selectedValue = this.value;
    if (selectedValue) {
        addSelectedVehicle(selectedValue);
        // Reset dropdown to default option
        this.selectedIndex = 0;
    }
});

// Apply vehicle filter button
document.getElementById('apply-vehicle-filter').addEventListener('click', function() {
    const vehicleInput = document.getElementById('vehicle-search');
    const vehicleValue = vehicleInput.value.trim();
    
    // If search field has value and it's not already in selected vehicles, add it
    if (vehicleValue && !selectedVehicles.includes(vehicleValue)) {
        addSelectedVehicle(vehicleValue);
    }
    
    if (selectedVehicles.length === 0) {
        alert('Please select at least one vehicle');
        return;
    }
    
    // Apply the filter
    filters.vehicle = selectedVehicles.join(',');
    sendFilters();
    
    // Find the vehicles on the map and zoom to them
    zoomToSelectedVehicles(filters.vehicle);
});

// Clear vehicle filter button
document.getElementById('clear-vehicle-filter').addEventListener('click', function() {
    document.getElementById('vehicle-search').value = '';
    selectedVehicles = [];
    updateSelectedVehiclesUI();
    
    // Clear the filter
    filters.vehicle = '';
    sendFilters();
});

// Zoom to selected vehicles on the map
function zoomToSelectedVehicles(vehicleId) {
    if (!vehicleId) return;
    
    // Split by commas if multiple vehicles
    const vehicleIds = vehicleId.split(',').map(id => id.trim());
    
    // Find features for selected vehicles
    const selectedFeatures = allFeatures.filter(feature => {
        if (!feature.properties || !feature.properties.id) return false;
        return vehicleIds.includes(feature.properties.id);
    });
    
    if (selectedFeatures.length === 0) {
        console.log('No features found for vehicle(s): ' + vehicleId);
        return;
    }
    
    // Calculate the extent of all selected features
    const coordinates = selectedFeatures.map(feature => 
        ol.proj.fromLonLat(feature.geometry.coordinates)
    );
    
    if (coordinates.length === 1) {
        // If only one vehicle, zoom to it
        map.getView().animate({
            center: coordinates[0],
            zoom: 15,
            duration: 1000
        });
    } else {
        // If multiple vehicles, fit view to include all
        const extent = coordinates.reduce((ext, coord) => {
            return ol.extent.extend(ext, [coord[0], coord[1], coord[0], coord[1]]);
        }, ol.extent.createEmpty());
        
        // Add some padding
        const padding = [50, 50, 50, 50];
        map.getView().fit(extent, {
            padding: padding,
            duration: 1000
        });
    }
}

// Enter key handler for vehicle search
document.getElementById('vehicle-search').addEventListener('keypress', function(e) {
    if (e.key === 'Enter') {
        e.preventDefault();
        document.getElementById('apply-vehicle-filter').click();
    }
});

// Date filter event listeners
document.getElementById('apply-date-filter').addEventListener('click', function() {
    const dateFrom = document.getElementById('date-from').value;
    const dateTo = document.getElementById('date-to').value;
    
    filters.dateFrom = dateFrom;
    filters.dateTo = dateTo;
    sendFilters();
});

document.getElementById('clear-date-filter').addEventListener('click', function() {
    document.getElementById('date-from').value = '';
    document.getElementById('date-to').value = '';
    filters.dateFrom = '';
    filters.dateTo = '';
    sendFilters();
});

// Search form event listener
document.getElementById('search-form').addEventListener('submit', function(e) {
    e.preventDefault();
    const searchInput = document.getElementById('truck-search');
    filters.vehicle = searchInput.value.trim();
    document.getElementById('vehicle-id-filter').value = filters.vehicle;
    sendFilters();
});

// Initialize on document load
document.addEventListener('DOMContentLoaded', function() {
    const sidebar = document.getElementById('sidebar');
    // Start with sidebar open
    sidebar.classList.remove('collapsed');
    // Hide the show button initially
    document.getElementById('sidebar-toggle-container').style.display = 'none';
});

// Sidebar collapse button (in the header) - closes the sidebar
document.getElementById('toggle-sidebar').addEventListener('click', function() {
const sidebar = document.getElementById('sidebar');
sidebar.classList.add('collapsed');
// Show the toggle container when sidebar is collapsed
document.getElementById('sidebar-toggle-container').style.display = 'block';
setTimeout(() => map.updateSize(), 300); // Match CSS transition duration
});

// Show sidebar button - opens the sidebar
document.getElementById('show-sidebar').addEventListener('click', function() {
const sidebar = document.getElementById('sidebar');
sidebar.classList.remove('collapsed');
// Hide the toggle container when sidebar is open
document.getElementById('sidebar-toggle-container').style.display = 'none';
setTimeout(() => map.updateSize(), 300); // Match CSS transition duration
});

// Map moveend event
map.on('moveend', queryClusters);