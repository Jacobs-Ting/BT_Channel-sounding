// --- Constants & Physical Parameters ---
const c = 300000000; // Speed of light in m/s
const N = 72; // Total channels
const df = 1000000; // 1 MHz spacing
const multipathExtraDist = 4; // Fixed extra distance for multipath reflection in meters
const multipathIntensity = 1.3; // Reflection intensity (intentionally higher for false peak)

// --- DOM Elements ---
const distanceSlider = document.getElementById('distance-slider');
const distanceVal = document.getElementById('distance-val');
const envModeSelect = document.getElementById('env-mode');
const dspCalibToggle = document.getElementById('dsp-calib');
const startBtn = document.getElementById('start-btn');

const metricTof = document.getElementById('metric-tof');
const metricPhase = document.getElementById('metric-phase');
const metricDist = document.getElementById('metric-dist');

const ueDevice = document.getElementById('ue-device');
const tagDevice = document.getElementById('tag-device');
const waveContainer = document.getElementById('wave-container');
const boundaries = document.querySelectorAll('.boundary');

// --- Global Chart Variables ---
let phaseChartInstance = null;
let cirChartInstance = null;
let animationTimeout = null;
let chartInterval = null;

// --- Initialize Application ---
function init() {
    initCharts();
    
    // Event Listeners
    distanceSlider.addEventListener('input', (e) => {
        distanceVal.textContent = e.target.value;
        updateDevicePositions();
    });
    
    startBtn.addEventListener('click', startSoundingSequence);

    // Initial positioning
    updateDevicePositions();
}

function updateDevicePositions() {
    const dist = parseFloat(distanceSlider.value);
    // Map 2m-20m to a reasonable percentage across the container
    // Let's say 2m = 20% width, 20m = 80% width separation
    const minPercent = 20;
    const maxPercent = 80;
    const percent = minPercent + ((dist - 2) / 18) * (maxPercent - minPercent);
    
    tagDevice.style.left = `calc(${percent}% + 40px)`;
    tagDevice.style.right = 'auto'; // override default
}

// --- Mathematical Models ---

// Complex Signal Superposition
function generateComplexSignals(d, isMultipath) {
    const complexSignals = [];
    const phases = [];
    
    for (let k = 0; k < N; k++) {
        const f_k = k * df;
        
        // LoS Phase: phi = -4 * PI * d * f_k / c
        const phase_LoS = (-4 * Math.PI * d * f_k) / c;
        let realPart = Math.cos(phase_LoS);
        let imagPart = Math.sin(phase_LoS);
        
        if (isMultipath) {
            // NLoS Phase
            const phase_NLoS = (-4 * Math.PI * (d + multipathExtraDist) * f_k) / c;
            // Add NLoS vector
            realPart += multipathIntensity * Math.cos(phase_NLoS);
            imagPart += multipathIntensity * Math.sin(phase_NLoS);
        }
        
        complexSignals.push({ real: realPart, imag: imagPart });
        phases.push(Math.atan2(imagPart, realPart)); // Wrapped phase [-pi, pi]
    }
    
    return { complexSignals, phases: unwrapPhase(phases) };
}

// Phase Unwrapping Algorithm
function unwrapPhase(phases) {
    if (phases.length === 0) return [];
    const unwrapped = [phases[0]];
    let offset = 0;
    
    for (let i = 1; i < phases.length; i++) {
        let delta = phases[i] - phases[i-1];
        
        // If phase jumps by more than pi, adjust the offset
        if (delta > Math.PI) {
            offset -= 2 * Math.PI;
        } else if (delta < -Math.PI) {
            offset += 2 * Math.PI;
        }
        
        unwrapped.push(phases[i] + offset);
    }
    return unwrapped;
}

// Perform IDFT (Inverse Discrete Fourier Transform) with Hann Window
function computeCIR(complexSignals) {
    const inputSize = complexSignals.length;
    const nfft = 512; // Zero-padded for smooth interpolation
    
    const cirMag = new Array(nfft).fill(0);
    const distances = new Array(nfft).fill(0);
    
    // Max unaliased distance for 1MHz step is c / (2 * df) = 150m.
    const maxDist = c / (2 * df); // 150m
    
    for (let n = 0; n < nfft; n++) {
        let sumReal = 0;
        let sumImag = 0;
        
        for (let k = 0; k < inputSize; k++) {
            // Removed Hann window because it halves the spatial resolution (making 11m and 15m merge)
            const windowVal = 1; 
            
            const S_real = complexSignals[k].real * windowVal;
            const S_imag = complexSignals[k].imag * windowVal;
            
            // IDFT twiddle: exp(j * 2 * pi * k * n / nfft)
            const angle = (2 * Math.PI * k * n) / nfft;
            const twiddle_real = Math.cos(angle);
            const twiddle_imag = Math.sin(angle);
            
            // Complex multiplication
            sumReal += (S_real * twiddle_real - S_imag * twiddle_imag);
            sumImag += (S_real * twiddle_imag + S_imag * twiddle_real);
        }
        
        // Magnitude
        cirMag[n] = Math.sqrt(sumReal*sumReal + sumImag*sumImag) / inputSize;
        distances[n] = (n * maxDist) / nfft;
    }
    
    // We only care about distances 0 to 30m, so filter the results
    const filteredDistances = [];
    const filteredMag = [];
    
    for(let i=0; i<nfft; i++) {
        if(distances[i] <= 30) {
            filteredDistances.push(distances[i]);
            filteredMag.push(cirMag[i]);
        }
    }
    
    return { distances: filteredDistances, magnitudes: filteredMag };
}

// --- Chart setup ---
function initCharts() {
    const phaseCtx = document.getElementById('phaseChart').getContext('2d');
    const cirCtx = document.getElementById('cirChart').getContext('2d');
    
    Chart.defaults.color = '#c5c6c7';
    Chart.defaults.font.family = "'Inter', 'Noto Sans TC', sans-serif";
    
    phaseChartInstance = new Chart(phaseCtx, {
        type: 'line',
        data: {
            labels: Array.from({length: N}, (_, i) => i),
            datasets: [{
                label: 'Unwrapped Phase (rad)',
                data: [],
                borderColor: '#66fcf1',
                backgroundColor: 'rgba(102, 252, 241, 0.1)',
                borderWidth: 2,
                pointRadius: 1,
                fill: true,
                tension: 0.2
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            scales: {
                x: {
                    title: { display: true, text: 'Channel Index (0-71)' },
                    grid: { color: 'rgba(255,255,255,0.1)' }
                },
                y: {
                    title: { display: true, text: 'Phase (rad)' },
                    grid: { color: 'rgba(255,255,255,0.1)' }
                }
            },
            plugins: {
                legend: { display: false }
            }
        }
    });
    
    // Custom Plugin for ToF Validation Window
    const validationWindowPlugin = {
        id: 'validationWindow',
        beforeDraw: (chart) => {
            if (!chart.config.options.plugins.validationWindow || !chart.config.options.plugins.validationWindow.active) return;
            const ctx = chart.ctx;
            const xAxis = chart.scales.x;
            const yAxis = chart.scales.y;
            
            const minIndex = chart.config.options.plugins.validationWindow.minIndex;
            const maxIndex = chart.config.options.plugins.validationWindow.maxIndex;
            
            if (minIndex === undefined || maxIndex === undefined) return;
            
            const startPx = xAxis.getPixelForTick(minIndex);
            const endPx = xAxis.getPixelForTick(maxIndex);
            
            ctx.save();
            ctx.fillStyle = 'rgba(102, 252, 241, 0.15)'; // Glassy cyan box
            ctx.fillRect(startPx, yAxis.top, endPx - startPx, yAxis.bottom - yAxis.top);
            
            // Draw window borders
            ctx.strokeStyle = 'rgba(102, 252, 241, 0.5)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(startPx, yAxis.top);
            ctx.lineTo(startPx, yAxis.bottom);
            ctx.moveTo(endPx, yAxis.top);
            ctx.lineTo(endPx, yAxis.bottom);
            ctx.stroke();
            ctx.restore();
        }
    };
    
    cirChartInstance = new Chart(cirCtx, {
        type: 'line',
        data: {
            labels: [], // Distances
            datasets: [
                {
                    label: 'Impulse Magnitude',
                    data: [],
                    borderColor: '#f2a900',
                    backgroundColor: 'rgba(242, 169, 0, 0.2)',
                    borderWidth: 2,
                    pointRadius: 0,
                    fill: true,
                    tension: 0.4,
                    order: 2
                },
                {
                    label: 'Selected Peak',
                    data: [], // Array of {x: index, y: value} for scatter
                    type: 'scatter',
                    backgroundColor: '#66fcf1',
                    borderColor: '#ffffff',
                    borderWidth: 2,
                    pointRadius: 6,
                    pointHoverRadius: 8,
                    order: 1
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                x: {
                    title: { display: true, text: 'Distance (m)' },
                    grid: { color: 'rgba(255,255,255,0.1)' }
                },
                y: {
                    title: { display: true, text: 'Normalized Magnitude' },
                    grid: { color: 'rgba(255,255,255,0.1)' },
                    beginAtZero: true
                }
            },
            plugins: {
                legend: { display: false },
                validationWindow: { active: false }
            }
        },
        plugins: [validationWindowPlugin]
    });
}

// --- Sequence Logic ---
function startSoundingSequence() {
    // 1. Reset UI
    startBtn.disabled = true;
    startBtn.textContent = 'Sounding in progress...';
    
    const trueDist = parseFloat(distanceSlider.value);
    const isMultipath = envModeSelect.value === 'multi-path';
    
    metricTof.textContent = '0.00 ns';
    metricPhase.textContent = 'Measuring...';
    metricDist.textContent = 'Measuring...';
    
    metricTof.classList.add('measuring');
    metricPhase.classList.add('measuring');
    metricDist.classList.add('measuring');
    
    // Clear Charts & Window
    phaseChartInstance.data.datasets[0].data = [];
    phaseChartInstance.update();
    cirChartInstance.data.labels = [];
    cirChartInstance.data.datasets[0].data = [];
    cirChartInstance.data.datasets[1].data = []; // Scatter points
    cirChartInstance.options.plugins.validationWindow.active = false;
    cirChartInstance.update();
    
    // Generate complex signals and unwrapped phase
    const signalData = generateComplexSignals(trueDist, isMultipath);
    const fullPhaseData = signalData.phases;
    const fullComplexData = signalData.complexSignals;
    
    // Calculate final ToF early for the animation counter
    let finalTof_ns = (2 * trueDist / c) * 1e9;
    
    if (isMultipath) {
        // ToF should be roughly accurate to True Distance with minor jitter (+/- 2ns)
        const jitter = (Math.random() * 4) - 2; 
        finalTof_ns += jitter;
    }
    
    // 2. Spatial Animation
    const totalDuration = 3000; // 3 seconds
    animateWaves(isMultipath, totalDuration);
    
    // 3. Sequential Chart Plotting & ToF Counter
    let currentK = 0;
    const intervalTime = totalDuration / N; // ~41ms per point
    let startTime = Date.now();
    
    if(chartInterval) clearInterval(chartInterval);
    
    chartInterval = setInterval(() => {
        let elapsed = Date.now() - startTime;
        let progress = Math.min(elapsed / totalDuration, 1);
        
        // Dynamically update ToF counter
        metricTof.textContent = (progress * finalTof_ns).toFixed(2) + ' ns';

        if(currentK < N) {
            phaseChartInstance.data.datasets[0].data.push(fullPhaseData[currentK]);
            phaseChartInstance.update();
            metricPhase.textContent = fullPhaseData[currentK].toFixed(2) + ' rad';
            currentK++;
        }
        
        // We use slightly more than 1 to ensure final step is caught if timing skips
        if (elapsed >= totalDuration && currentK >= N) {
            clearInterval(chartInterval);
            finishSequence(trueDist, finalTof_ns, fullComplexData);
        }
    }, intervalTime);
}

const svgNS = "http://www.w3.org/2000/svg";

function createEMWaveSvgOverlay() {
    const svg = document.createElementNS(svgNS, "svg");
    svg.style.position = 'absolute';
    svg.style.top = '0';
    svg.style.left = '0';
    svg.style.width = '100%';
    svg.style.height = '100%';
    svg.style.pointerEvents = 'none';
    svg.style.zIndex = '5';
    svg.innerHTML = `
        <defs>
            <filter id="glow-cyan" x="-20%" y="-20%" width="140%" height="140%">
                <feGaussianBlur stdDeviation="3" result="blur" />
                <feComposite in="SourceGraphic" in2="blur" operator="over" />
            </filter>
            <filter id="glow-red" x="-20%" y="-20%" width="140%" height="140%">
                <feGaussianBlur stdDeviation="3" result="blur" />
                <feComposite in="SourceGraphic" in2="blur" operator="over" />
            </filter>
        </defs>
    `;
    waveContainer.appendChild(svg);
    return svg;
}

function getWavyPath(x1, y1, x2, y2, amplitude, frequency) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const distance = Math.sqrt(dx*dx + dy*dy);
    const angle = Math.atan2(dy, dx);
    
    let dStr = `M ${x1} ${y1} `;
    
    const step = 3; // px
    for(let d=step; d<=distance; d+=step) {
        const bx = x1 + Math.cos(angle) * d;
        const by = y1 + Math.sin(angle) * d;
        const offset = Math.sin(d * frequency) * amplitude;
        const ox = bx - Math.sin(angle) * offset;
        const oy = by + Math.cos(angle) * offset;
        dStr += `L ${ox.toFixed(2)} ${oy.toFixed(2)} `;
    }
    dStr += `L ${x2} ${y2} `;
    return dStr;
}

function animateEMPacket(svg, pathData, duration, isMultipath, delay) {
    const path = document.createElementNS(svgNS, "path");
    path.setAttribute('d', pathData);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', isMultipath ? '#f05454' : '#66fcf1');
    path.setAttribute('stroke-width', '3');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('filter', isMultipath ? 'url(#glow-red)' : 'url(#glow-cyan)');
    path.style.opacity = '0';
    
    svg.appendChild(path);
    
    const length = path.getTotalLength();
    const packetLength = 100; // Visual length of the EM wave packet
    
    path.setAttribute('stroke-dasharray', `${packetLength} ${length}`);
    path.setAttribute('stroke-dashoffset', packetLength);
    
    setTimeout(() => {
        path.style.opacity = '1';
        path.animate([
            { strokeDashoffset: packetLength },
            { strokeDashoffset: -length }
        ], {
            duration: duration,
            easing: 'linear',
            fill: 'forwards'
        }).onfinish = () => {
            path.style.opacity = '0';
        };
    }, delay);
}

function animateWaves(isMultipath, totalDuration) {
    waveContainer.innerHTML = '';
    
    if(isMultipath) {
        boundaries.forEach(b => b.classList.add('active'));
    } else {
        boundaries.forEach(b => b.classList.remove('active'));
    }
    
    const ueRect = ueDevice.getBoundingClientRect();
    const tagRect = tagDevice.getBoundingClientRect();
    const containerRect = document.getElementById('spatial-container').getBoundingClientRect();
    
    const startX = ueRect.left - containerRect.left + (ueRect.width/2);
    const startY = ueRect.top - containerRect.top + (ueRect.height/2);
    
    const targetX = tagRect.left - containerRect.left + (tagRect.width/2);
    const targetY = tagRect.top - containerRect.top + (tagRect.height/2);
    
    const halfDuration = totalDuration / 2;
    const svg = createEMWaveSvgOverlay();
    
    // Wave properties
    const amp = 8;
    const freq = 0.15;
    
    // LoS Paths
    const pathForward = getWavyPath(startX, startY, targetX, targetY, amp, freq);
    const pathBackward = getWavyPath(targetX, targetY, startX, startY, amp, freq);
    
    animateEMPacket(svg, pathForward, halfDuration, false, 0);
    animateEMPacket(svg, pathBackward, halfDuration, false, halfDuration);
    
    // Antenna Impact Ripples
    createRipple(startX, startY, 800, false, 0);
    createRipple(targetX, targetY, 800, false, halfDuration);
    createRipple(startX, startY, 800, false, totalDuration); // Final arrival
    
    // NLoS Paths
    if(isMultipath) {
        const topBoundaryY = 20; 
        const midX = startX + (targetX - startX) / 2;
        
        const pathMultiForward = getWavyPath(startX, startY, midX, topBoundaryY, amp, freq) + 
                                 getWavyPath(midX, topBoundaryY, targetX, targetY, amp, freq).replace('M', 'L');
        
        const pathMultiBackward = getWavyPath(targetX, targetY, midX, topBoundaryY, amp, freq) + 
                                  getWavyPath(midX, topBoundaryY, startX, startY, amp, freq).replace('M', 'L');
                                  
        // NLoS travels slightly slower due to longer path, but for UI sync we keep duration same
        animateEMPacket(svg, pathMultiForward, halfDuration, true, 0);
        animateEMPacket(svg, pathMultiBackward, halfDuration, true, halfDuration);
        
        createRipple(startX, startY, 800, true, 0);
        createRipple(targetX, targetY, 800, true, halfDuration);
        createRipple(startX, startY, 800, true, totalDuration);
    }
}

function createRipple(x, y, duration, isMultipath, delay) {
    setTimeout(() => {
        const ripple = document.createElement('div');
        ripple.classList.add('wave');
        if(isMultipath) ripple.classList.add('multipath');
        
        ripple.style.left = `${x}px`;
        ripple.style.top = `${y}px`;
        
        waveContainer.appendChild(ripple);
        
        ripple.animate([
            { transform: 'translate(-50%, -50%) scale(0)', opacity: 0.8 },
            { transform: 'translate(-50%, -50%) scale(12)', opacity: 0 }
        ], {
            duration: duration,
            easing: 'ease-out',
            fill: 'forwards'
        }).onfinish = () => ripple.remove();
    }, delay);
}

function finishSequence(trueDist, finalTof_ns, fullComplexData) {
    // Remove measuring state
    metricTof.classList.remove('measuring');
    metricPhase.classList.remove('measuring');
    metricDist.classList.remove('measuring');
    
    // Re-enable button
    startBtn.disabled = false;
    startBtn.textContent = '🚀 Start Sounding Sequence';
    
    // Calculate ToF Distance from the measured ns
    const tofDist = (finalTof_ns / 1e9) * c / 2;
    metricTof.textContent = finalTof_ns.toFixed(2) + ' ns';
    
    // Draw CIR Chart
    const cirData = computeCIR(fullComplexData);
    cirChartInstance.data.labels = cirData.distances.map(d => d.toFixed(1));
    cirChartInstance.data.datasets[0].data = cirData.magnitudes;
    
    const isCalibOn = dspCalibToggle.checked;
    let estimatedDist = 0;
    let selectedPeakIndex = -1;
    
    // Simple Peak Detection (finding local maxima)
    const peaks = [];
    for (let i = 1; i < cirData.magnitudes.length - 1; i++) {
        if (cirData.magnitudes[i] > cirData.magnitudes[i-1] && cirData.magnitudes[i] > cirData.magnitudes[i+1]) {
            peaks.push({ index: i, dist: cirData.distances[i], mag: cirData.magnitudes[i] });
        }
    }
    
    if (peaks.length === 0) {
        // Fallback
        const maxMag = Math.max(...cirData.magnitudes);
        selectedPeakIndex = cirData.magnitudes.indexOf(maxMag);
        estimatedDist = cirData.distances[selectedPeakIndex];
    } else if (!isCalibOn) {
        // Scenario A: No Calibration. Pick the global maximum peak.
        // Due to multipathIntensity = 1.3, this will be the wrong peak.
        peaks.sort((a, b) => b.mag - a.mag); 
        selectedPeakIndex = peaks[0].index;
        estimatedDist = peaks[0].dist;
        cirChartInstance.options.plugins.validationWindow.active = false;
    } else {
        // Scenario B: Calibration ON. Use ToF fusion.
        // Window = ToF dist +/- 3m
        const windowRadius = 3.0; 
        const minValidDist = tofDist - windowRadius;
        const maxValidDist = tofDist + windowRadius;
        
        // Find min and max indices for the visual shaded window
        let minIndex = 0, maxIndex = cirData.distances.length - 1;
        for(let i=0; i<cirData.distances.length; i++) {
            if(cirData.distances[i] >= minValidDist && minIndex === 0) minIndex = i;
            if(cirData.distances[i] <= maxValidDist) maxIndex = i;
        }
        
        cirChartInstance.options.plugins.validationWindow = {
            active: true,
            minIndex: minIndex,
            maxIndex: maxIndex
        };
        
        // Find the FIRST peak inside this window exceeding the required energy threshold
        // User requested: strictly require signal magnitude > 0.5 to ignore side lobes
        const noiseThreshold = 0.5; 
        
        // Sort peaks by distance (first path first)
        peaks.sort((a, b) => a.dist - b.dist);
        
        let found = false;
        for (const p of peaks) {
            if (p.dist >= minValidDist && p.dist <= maxValidDist && p.mag >= noiseThreshold) {
                selectedPeakIndex = p.index;
                estimatedDist = p.dist;
                found = true;
                break;
            }
        }
        
        // Fallback if no peak in window
        if (!found) {
            peaks.sort((a, b) => b.mag - a.mag); 
            selectedPeakIndex = peaks[0].index;
            estimatedDist = peaks[0].dist;
        }
    }
    
    // Set Scatter Data Point
    cirChartInstance.data.datasets[1].data = [];
    if (selectedPeakIndex !== -1) {
        // We use string key for x because the scale is category.
        // In Chart.js category scale, scatter points can be mapped using string x.
        cirChartInstance.data.datasets[1].data.push({
            x: cirData.distances[selectedPeakIndex].toFixed(1),
            y: cirData.magnitudes[selectedPeakIndex]
        });
    }
    
    metricDist.textContent = estimatedDist.toFixed(2) + ' m';
    
    if (isCalibOn) {
        metricDist.classList.remove('neon-text-blue');
        metricDist.style.color = '#66fcf1'; // Keep it glowing
    }

    cirChartInstance.update();
    
    // Cleanup wave boundaries
    boundaries.forEach(b => b.classList.remove('active'));
}

// Start
window.addEventListener('DOMContentLoaded', init);
