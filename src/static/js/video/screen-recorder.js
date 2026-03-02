import { Logger } from '../utils/logger.js';
import { ApplicationError, ErrorCodes } from '../utils/error-boundary.js';

/**
 * @fileoverview Implements a screen recorder for capturing and processing screen frames.
 * It supports previewing the screen capture and sending frames to a callback function.
 */
export class ScreenRecorder {
    /**
     * Creates a new ScreenRecorder instance.
     * @param {Object} [options] - Configuration options for the recorder.
     * @param {number} [options.fps=5] - Frames per second for screen capture.
     * @param {number} [options.quality=0.8] - JPEG quality for captured frames (0.0 - 1.0).
     * @param {number} [options.width=1280] - Width of the captured video.
     * @param {number} [options.height=720] - Height of the captured video.
     * @param {number} [options.maxFrameSize=204800] - Maximum size of a frame in bytes (200KB).
     */
    constructor(options = {}) {
        this.stream = null;
        this.isRecording = false;
        this.onScreenData = null;
        //离屏处理 Canvas (用于抽帧和像素比对)
        this.frameCanvas = document.createElement('canvas');
        this.frameCtx = this.frameCanvas.getContext('2d',{ willReadFrequently: true }); // 开启优化通道
        this.captureInterval = null;
        this.previewElement = null;
        this.options = {
            quality: 0.6,
            width: 640,
            height: 480,
            maxFrameSize: 500 * 1024, // 500KB max per frame
            motionThreshold: 10,   // 移动检测阈值（10属于微小变动）
            forceFrameInterval: 20, // 每隔20帧（被判定有效变化帧才计入）强制发送（即使这一帧确实没有变化）
            ...options
        };
        this.frameCount = 0;
        // 状态追踪（上一帧的数据，用来做move detection）
        this.lastPixelData = null;
    }

    /**
     * Starts screen recording.
     * @param {HTMLVideoElement} previewElement - The video element to display the screen preview.
     * @param {Function} onScreenData - Callback function to receive screen frame data.
     * @throws {ApplicationError} Throws an error if screen sharing permission is denied or if the screen recording fails to start.
     */
    async start(previewElement, onScreenData) {
        try {
            this.onScreenData = onScreenData;
            this.previewElement = previewElement;

            // Request screen sharing access with audio
            this.stream = await navigator.mediaDevices.getDisplayMedia({ 
                video: {
                    width: { ideal: this.options.width },
                    height: { ideal: this.options.height },
                    frameRate: { ideal: this.options.fps }
                },
                audio: false // Set to true if you want to capture audio as well
            });

            // Set up preview
            if (this.previewElement) {
                this.previewElement.srcObject = this.stream;
                await new Promise((resolve) => {
                    this.previewElement.onloadedmetadata = () => {
                        this.previewElement.play()
                            .then(resolve)
                            .catch(error => {
                                Logger.error('Failed to play preview:', error);
                                resolve();
                            });
                    };
                });

                // Set canvas size based on video dimensions
                this.frameCanvas.width = this.previewElement.videoWidth;
                this.frameCanvas.height = this.previewElement.videoHeight;
                Logger.info(`Screen preview set up with dimensions ${this.frameCanvas.width}x${this.frameCanvas.height}`);
            }

            // Start frame capture loop
            this.isRecording = true;
            this.runFrameCaptureLoop();
            
            // Handle stream stop
            this.stream.getVideoTracks()[0].addEventListener('ended', () => {
                this.stop();
            });

            Logger.info('Screen recording started');

        } catch (error) {
            if (error.name === 'NotAllowedError') {
                throw new ApplicationError(
                    'Screen sharing permission denied',
                    ErrorCodes.SCREEN_PERMISSION_DENIED,
                    { originalError: error }
                );
            }
            throw new ApplicationError(
                'Failed to start screen recording',
                ErrorCodes.SCREEN_START_FAILED,
                { originalError: error }
            );
        }
    }

    /**
     * Starts the frame capture loop.
     * @private
     */
    runFrameCaptureLoop() {
        const frameInterval = 1000 / this.options.fps;
        
        this.captureInterval = setInterval(() => {
            if (!this.isRecording || !this.previewElement || !this.onScreenData) return;
            
            try {
                // Ensure video is playing and ready
                if (this.previewElement.readyState >= this.previewElement.HAVE_CURRENT_DATA) {
                    // Update canvas size if needed
                    if (this.frameCanvas.width !== this.previewElement.videoWidth) {
                        this.frameCanvas.width = this.previewElement.videoWidth;
                        this.frameCanvas.height = this.previewElement.videoHeight;
                    }

                    // Draw current video frame to canvas
                    this.frameCtx.drawImage(
                        this.previewElement,
                        0, 0,
                        this.frameCanvas.width,
                        this.frameCanvas.height
                    );

                    // 获取当前截图数据
                    const imageData = this.frameCtx.getImageData(0, 0, this.frameCanvas.width, this.frameCanvas.height);
                    const currentPixels = imageData.data;

                    // 移动检测逻辑
                    let shouldSend = false;
                    if (!this.lastPixelData || (this.frameCount % this.options.forceFrameInterval === 0)) {
                        shouldSend = true; // 全新数据，或者到了强制发送的轮数
                    } else {
                        const motionScore = this.calculateMotion(this.lastPixelData, currentPixels);
                        if (motionScore >= this.options.motionThreshold) {
                            shouldSend = true;
                        }
                    }
                    
                    // 如果需要发送帧数据，再检查和加工并调用回调处理
                    if (shouldSend) {
                        // Convert to JPEG with quality setting
                        const jpegData = this.frameCanvas.toDataURL('image/jpeg', this.options.quality);
                        const base64Data = jpegData.split(',')[1];
                        
                        if (this.validateFrame(base64Data)) {
                            // 保存当前的像素数据
                            this.lastPixelData = currentPixels;
                            this.frameCount++;
                            Logger.debug(`Screen frame #${this.frameCount} captured`);
                            this.onScreenData(base64Data);
                        }                        
                    }                   
                }
            } catch (error) {
                Logger.error('Screen frame capture error:', error);
            }
        }, frameInterval);

        Logger.info(`Screen capture started at ${this.options.fps} FPS`);
    }

    /**
     * Stops screen recording.
     * @throws {ApplicationError} Throws an error if the screen recording fails to stop.
     */
    stop() {
        try {
            this.isRecording = false;
            
            if (this.captureInterval) {
                clearInterval(this.captureInterval);
                this.captureInterval = null;
            }

            if (this.stream) {
                this.stream.getTracks().forEach(track => track.stop());
                this.stream = null;
            }

            if (this.previewElement) {
                this.previewElement.srcObject = null;
                this.previewElement = null;
            }

            Logger.info('Screen recording stopped');

        } catch (error) {
            Logger.error('Failed to stop screen recording:', error);
            throw new ApplicationError(
                'Failed to stop screen recording',
                ErrorCodes.SCREEN_STOP_FAILED,
                { originalError: error }
            );
        }
    }

    /**
     * Checks if screen sharing is supported by the browser.
     * @returns {boolean} True if screen sharing is supported, false otherwise.
     * @throws {ApplicationError} Throws an error if screen sharing is not supported.
     * @static
     */
    static checkBrowserSupport() {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
            throw new ApplicationError(
                'Screen sharing is not supported in this browser',
                ErrorCodes.SCREEN_NOT_SUPPORTED
            );
        }
        return true;
    }
        /**
     * Validates a captured frame.
     * @param {string} base64Data - Base64 encoded frame data.
     * @returns {boolean} True if the frame is valid, false otherwise.
     * @private
     */
    validateFrame(base64Data) {
        if (!base64Data) { Logger.error('Empty frame data'); return false; } 
        // Check if it's a valid base64 string
        if (!/^[A-Za-z0-9+/=]+$/.test(base64Data)) {
            Logger.error('Invalid base64 data');
            return false;
        }
        
        // Check minimum size (1KB)
        if (base64Data.length < 1024) {
            Logger.error('Frame too small');
            return false;
        }

        if(base64Data.length >= this.options.maxFrameSize){
            Logger.warn('Frame size exceeds max allowed size');
            return false; // 更好的处理是调用OptimizeFrameQuality方法来降低分辨率
        }        
        return true;
    }

    /**
     * Optimizes the frame quality to reduce size.
     * @param {string} base64Data - Base64 encoded frame data.
     * @returns {string} Optimized base64 encoded frame data.
     * @private
     */
    async optimizeFrameQuality(base64Data) {
        let quality = this.options.quality;
        let currentSize = base64Data.length;
        
        while (currentSize > this.options.maxFrameSize && quality > 0.3) {
            quality -= 0.1;
            const jpegData = this.frameCanvas.toDataURL('image/jpeg', quality);
            base64Data = jpegData.split(',')[1];
            currentSize = base64Data.length;
        }
        
        return base64Data;
    }

    /**
     * 像素级移动检测 (算法优化)，返回两套图像数据的像素（抽样）差异比值（0表示不变，5-15微小变化，30-100明显变化，>200剧烈变化）
     */
    calculateMotion(prev, curr) {
        let diff = 0;
        const step = 8; // 抽样步长，减少计算量
        for (let i = 0; i < prev.length; i += 4 * step) { // 因为原始数据是RGBA表示一个像素，所以每次跳过4个字节
            diff += Math.abs(prev[i] - curr[i]) + 
                    Math.abs(prev[i + 1] - curr[i + 1]) + 
                    Math.abs(prev[i + 2] - curr[i + 2]);
        }
        return diff / (prev.length / step);
    }
} 