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
const csOperatingMode = document.getElementById('cs-operating-mode');
const wifiInterferenceToggle = document.getElementById('wifi-interference');
const startBtn = document.getElementById('start-btn');

const metricTof = document.getElementById('metric-tof');
const metricPhase = document.getElementById('metric-phase');
const metricDist = document.getElementById('metric-dist');
const metricModeDetail = document.getElementById('metric-mode-detail');

const ueDevice = document.getElementById('ue-device');
const tagDevice = document.getElementById('tag-device');
const waveContainer = document.getElementById('wave-container');
const boundaries = document.querySelectorAll('.boundary');
const phaseViewButtons = document.querySelectorAll('.phase-view-btn');

// --- Global Chart Variables ---
let phaseChartInstance = null;
let cirChartInstance = null;
let animationTimeout = null;
let chartInterval = null;
let phaseView = 'dsp';
let latestPhaseData = null;
let hoppingSequence = [];
let strongestCIRDistance = null;
let mode1TofDistanceNoise = 0;
let mode1TofTimingNoiseNs = 0;

// --- Initialize Application ---
function init() {
    initCharts();
    
    // Event Listeners
    distanceSlider.addEventListener('input', (e) => {
        distanceVal.textContent = e.target.value;
        updateDevicePositions();
        updateCSOperatingMetric();
    });
    
    startBtn.addEventListener('click', startSoundingSequence);
    csOperatingMode.addEventListener('change', () => {
        syncCSOperatingMode();
        updateCSOperatingMetric();
        renderPhaseChart();
    });
    wifiInterferenceToggle.addEventListener('change', () => {
        updateCSOperatingMetric();
        renderPhaseChart();
    });
    phaseViewButtons.forEach((button) => {
        button.addEventListener('click', () => {
            phaseView = button.dataset.phaseView;
            phaseViewButtons.forEach((item) => item.classList.toggle('active', item === button));
            renderPhaseChart();
        });
    });

    // Initial positioning
    updateDevicePositions();
    syncCSOperatingMode();
    updateCSOperatingMetric();
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

function syncCSOperatingMode() {
    // Mode 1 can now choose either CIR strategy: first-path detection when enabled,
    // or the strongest impulse when Advanced DSP Calibration is disabled.
    dspCalibToggle.disabled = false;
}

function generateGaussian(mean = 0, standardDeviation = 1) {
    let u = 0;
    let v = 0;

    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();

    const standardNormal = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    return mean + standardNormal * standardDeviation;
}

function generateMode1TofTimingNoise() {
    // A ±1 m round-trip ranging error is equivalent to a ±6.67 ns ToF timing jitter.
    const distanceNoise = (Math.random() * 2 - 1) * 1.0;
    const timingNoiseNs = (2 * distanceNoise / c) * 1e9;
    return { distanceNoise, timingNoiseNs };
}

function updateCSOperatingMetric() {
    const trueDistance = parseFloat(distanceSlider.value);
    const isWiFiOn = wifiInterferenceToggle.checked;
    const D_amb = isWiFiOn ? 15.0 : 150.0;

    const tofNoise = generateGaussian(0, 1.5);
    const tofEst = Number((trueDistance + tofNoise).toFixed(2));

    const pbrNoise = generateGaussian(0, 0.05);
    const basePbr = (trueDistance % D_amb) + pbrNoise;
    const mode2Candidates = isWiFiOn
        ? [0, 1, 2].map((k) => Number((basePbr + k * D_amb).toFixed(2)))
        : [Number(basePbr.toFixed(2))];

    const fusionEst = mode2Candidates.reduce((previous, current) =>
        Math.abs(current - tofEst) < Math.abs(previous - tofEst) ? current : previous
    );

    metricModeDetail.className = 'metric-subtext';

    if (csOperatingMode.value === 'mode1') {
        // Mode 1 noise is generated as a timing jitter and converted back into range.
        const mode1Estimate = strongestCIRDistance ?? (trueDistance + mode1TofDistanceNoise);
        metricDist.textContent = `${mode1Estimate.toFixed(2)} m`;
        metricModeDetail.textContent = strongestCIRDistance === null
            ? 'ToF timing jitter: ±6.67ns | Range error: ±1m'
            : (dspCalibToggle.checked
                ? 'CIR: First path selected | ToF timing jitter: ±6.67ns'
                : 'CIR: Strongest impulse selected | ToF timing jitter: ±6.67ns');
        metricModeDetail.classList.add('mode-warning');
    } else if (csOperatingMode.value === 'mode2') {
        metricDist.textContent = `[${mode2Candidates.map((distance) => `${distance.toFixed(2)}m`).join(', ')}]`;
        metricModeDetail.textContent = isWiFiOn
            ? 'Precision: ±5cm | Ambiguity: HIGH (AFH Gaps)'
            : 'Precision: ±5cm | Ambiguity: None (Full Spectrum)';
        metricModeDetail.classList.add('mode-warning');
    } else {
        if (isWiFiOn) {
            const candidatesHtml = mode2Candidates.map((distance) => {
                const formattedDistance = `${distance.toFixed(2)}m`;
                return distance === fusionEst
                    ? `<span style="font-weight: bold; color: var(--primary-color, #00E676);">${formattedDistance}</span>`
                    : `<span style="text-decoration: line-through; opacity: 0.5;">${formattedDistance}</span>`;
            }).join(', ');

            metricDist.innerHTML = `[${candidatesHtml}]`;
            metricModeDetail.textContent = 'Precision: ±5cm | Ambiguity: Eliminated via ToF Fusion';
        } else {
            metricDist.textContent = `${fusionEst.toFixed(2)} m`;
            metricModeDetail.textContent = 'Precision: ±5cm | Full Spectrum';
        }
        metricModeDetail.classList.add('mode-success');
    }
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
    
    return {
        complexSignals,
        rawPhases: phases,
        phases: unwrapPhase(phases)
    };
}

function createHoppingSequence() {
    const sequence = Array.from({ length: N }, (_, index) => index);
    for (let index = sequence.length - 1; index > 0; index--) {
        const randomIndex = Math.floor(Math.random() * (index + 1));
        [sequence[index], sequence[randomIndex]] = [sequence[randomIndex], sequence[index]];
    }
    return sequence;
}

function renderPhaseChart(visiblePoints = N) {
    if (!latestPhaseData) return;

    const isHoppingView = phaseView === 'hopping';
    const shouldApplyAfhGap =
        wifiInterferenceToggle.checked &&
        csOperatingMode.value !== 'mode1';
    const receivedPairs = [];
    const receivedHopCount = Math.min(visiblePoints, hoppingSequence.length);

    // This is the single source of truth for both views: actual received hopping samples.
    for (let hopIndex = 0; hopIndex < receivedHopCount; hopIndex++) {
        const channelIndex = hoppingSequence[hopIndex];
        if (shouldApplyAfhGap && channelIndex >= 30 && channelIndex <= 45) continue;
        receivedPairs.push({
            hopIndex,
            channelIndex,
            rawPhase: latestPhaseData.rawPhases[channelIndex]
        });
    }

    let chartData;
    if (isHoppingView) {
        chartData = new Array(receivedHopCount).fill(null);
        receivedPairs.forEach(({ hopIndex, rawPhase }) => {
            chartData[hopIndex] = rawPhase;
        });
    } else {
        const sortedPairs = [...receivedPairs].sort((a, b) => a.channelIndex - b.channelIndex);
        const unwrappedPhases = unwrapPhase(sortedPairs.map(({ rawPhase }) => rawPhase));
        chartData = new Array(N).fill(null);
        sortedPairs.forEach(({ channelIndex }, index) => {
            chartData[channelIndex] = unwrappedPhases[index];
        });
    }

    phaseChartInstance.data.datasets[0] = isHoppingView
        ? {
            label: 'Random Hopping Phase (rad)',
            data: chartData,
            borderColor: 'transparent',
            backgroundColor: 'rgba(242, 169, 0, 0.9)',
            pointBorderColor: '#fff0c7',
            pointRadius: 3.5,
            pointHoverRadius: 5,
            showLine: false
        }
        : {
            label: 'DSP Reordered & Unwrapped Phase (rad)',
            data: chartData,
            borderColor: '#66fcf1',
            backgroundColor: 'rgba(102, 252, 241, 0.1)',
            borderWidth: 2,
            pointRadius: 1,
            fill: true,
            tension: 0.2,
            showLine: true
        };

    phaseChartInstance.options.scales.x.title.text = isHoppingView
        ? 'Hop Index (Random Channel Order)'
        : 'Channel Index (0-71)';
    phaseChartInstance.options.scales.y.title.text = isHoppingView
        ? 'Wrapped Phase (rad)'
        : 'Phase (rad)';

    if (isHoppingView) {
        phaseChartInstance.options.scales.y.min = -Math.PI;
        phaseChartInstance.options.scales.y.max = Math.PI;
    } else {
        delete phaseChartInstance.options.scales.y.min;
        delete phaseChartInstance.options.scales.y.max;
    }
    phaseChartInstance.update();
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
    const mode1TimingNoise = csOperatingMode.value === 'mode1'
        ? generateMode1TofTimingNoise()
        : { distanceNoise: 0, timingNoiseNs: 0 };
    mode1TofDistanceNoise = mode1TimingNoise.distanceNoise;
    mode1TofTimingNoiseNs = mode1TimingNoise.timingNoiseNs;
    
    metricTof.textContent = '0.00 ns';
    metricPhase.textContent = 'Measuring...';
    metricDist.textContent = 'Measuring...';
    strongestCIRDistance = null;
    
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
    
    // Generate complex signals, then scramble the received channel order.
    const signalData = generateComplexSignals(trueDist, isMultipath);
    latestPhaseData = signalData;
    hoppingSequence = createHoppingSequence();
    const fullComplexData = signalData.complexSignals;
    
    // Calculate final ToF early for the animation counter
    let finalTof_ns = (2 * trueDist / c) * 1e9;
    
    if (csOperatingMode.value === 'mode1') {
        finalTof_ns += mode1TofTimingNoiseNs;
    } else if (isMultipath) {
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
            renderPhaseChart(currentK + 1);
            const receivedChannel = hoppingSequence[currentK];
            metricPhase.textContent = signalData.rawPhases[receivedChannel].toFixed(2) + ' rad';
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
    
    // All CS operating modes can opt into first-path + ToF fusion.
    // When disabled, peak selection falls back to the globally strongest CIR impulse.
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

    // Mode 1 applies the same random ToF timing jitter (converted to metres) after
    // CIR selects either the first path or the strongest impulse.
    if (csOperatingMode.value === 'mode1') {
        strongestCIRDistance = Number((estimatedDist + mode1TofDistanceNoise).toFixed(2));
    }
    
    if (isCalibOn) {
        metricDist.classList.remove('neon-text-blue');
        metricDist.style.color = '#66fcf1'; // Keep it glowing
    }

    updateCSOperatingMetric();

    cirChartInstance.update();
    
    // Cleanup wave boundaries
    boundaries.forEach(b => b.classList.remove('active'));
}

// Start
window.addEventListener('DOMContentLoaded', init);
