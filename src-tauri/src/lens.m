#import <AppKit/AppKit.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#import <Vision/Vision.h>
#import <CoreMedia/CoreMedia.h>
#import <CoreVideo/CoreVideo.h>
#import <CoreGraphics/CoreGraphics.h>
#import <dispatch/dispatch.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>

static char *LensResponse(NSDictionary *response) {
    NSData *data = [NSJSONSerialization dataWithJSONObject:response options:0 error:nil];
    if (!data) return NULL;
    char *result = malloc(data.length + 1);
    if (!result) return NULL;
    memcpy(result, data.bytes, data.length);
    result[data.length] = 0;
    return result;
}

static NSError *LensError(NSString *message) {
    return [NSError errorWithDomain:@"AnywherePlamoLens" code:1
                          userInfo:@{NSLocalizedDescriptionKey: message}];
}

@interface PlamoLensFrame : NSObject <SCStreamOutput, SCStreamDelegate>
@property(nonatomic, strong) dispatch_semaphore_t ready;
@property(nonatomic) CVPixelBufferRef image;
@property(nonatomic, strong) NSError *error;
@property(nonatomic) BOOL finished;
- (void)finish:(CVPixelBufferRef)image error:(NSError *)error;
@end

@implementation PlamoLensFrame
- (instancetype)init {
    if ((self = [super init])) _ready = dispatch_semaphore_create(0);
    return self;
}
- (void)dealloc {
    if (_image) CVPixelBufferRelease(_image);
}
- (void)finish:(CVPixelBufferRef)image error:(NSError *)error {
    @synchronized (self) {
        if (_finished) return;
        _finished = YES;
        _image = image ? CVPixelBufferRetain(image) : NULL;
        _error = error;
        dispatch_semaphore_signal(_ready);
    }
}
- (void)stream:(SCStream *)stream didStopWithError:(NSError *)error {
    [self finish:NULL error:error];
}
- (void)stream:(SCStream *)stream didOutputSampleBuffer:(CMSampleBufferRef)sample
        ofType:(SCStreamOutputType)type {
    if (type != SCStreamOutputTypeScreen || !CMSampleBufferIsValid(sample)) return;
    NSArray *attachments = (__bridge NSArray *)CMSampleBufferGetSampleAttachmentsArray(sample, false);
    NSNumber *status = [attachments.firstObject objectForKey:SCStreamFrameInfoStatus];
    if (!status || status.integerValue != SCFrameStatusComplete) return;
    CVPixelBufferRef image = CMSampleBufferGetImageBuffer(sample);
    if (image) [self finish:image error:nil];
}
@end

// Rust calls this on a worker. Only the AppKit coordinate conversion uses the main thread.
char *plamo_lens_capture(void *windowPointer, double x, double y, double width, double height) {
    @autoreleasepool {
        if (!CGPreflightScreenCaptureAccess() && !CGRequestScreenCaptureAccess()) {
            return LensResponse(@{@"error": @"画面収録を許可してください。「システム設定 → プライバシーとセキュリティ → 画面収録」でAnywhere Plamoを許可し、アプリを再起動してください。"});
        }

        __block CGRect source = CGRectZero;
        __block CGDirectDisplayID displayID = 0;
        __block CGFloat scale = 1.0;
        dispatch_sync(dispatch_get_main_queue(), ^{
            NSWindow *window = (__bridge NSWindow *)windowPointer;
            NSView *view = window.contentView;
            if (!window.visible || !view) return;
            // Webview CSS coordinates are points, with the origin at the top left.
            NSRect region = NSMakeRect(x, view.isFlipped ? y : NSHeight(view.bounds) - y - height,
                                       width, height);
            if (!NSContainsRect(view.bounds, region)) return;
            NSRect screenRect = [window convertRectToScreen:[view convertRect:region toView:nil]];
            for (NSScreen *screen in NSScreen.screens) {
                // Keep the first version on one display; never silently crop a second display.
                if (!NSContainsRect(screen.frame, screenRect)) continue;
                displayID = [screen.deviceDescription[@"NSScreenNumber"] unsignedIntValue];
                scale = screen.backingScaleFactor;
                source = CGRectMake(NSMinX(screenRect) - NSMinX(screen.frame),
                                    NSMaxY(screen.frame) - NSMaxY(screenRect), width, height);
                break;
            }
        });
        if (!displayID) {
            return LensResponse(@{@"error": @"レンズ全体を1つの画面内に置いて、もう一度更新してください。"});
        }

        dispatch_semaphore_t available = dispatch_semaphore_create(0);
        __block SCShareableContent *content = nil;
        __block NSError *contentError = nil;
        [SCShareableContent getShareableContentExcludingDesktopWindows:NO onScreenWindowsOnly:YES
            completionHandler:^(SCShareableContent *value, NSError *error) {
                content = value;
                contentError = error;
                dispatch_semaphore_signal(available);
            }];
        if (dispatch_semaphore_wait(available, dispatch_time(DISPATCH_TIME_NOW, 10 * NSEC_PER_SEC))) {
            return LensResponse(@{@"error": @"画面の取得がタイムアウトしました。画面収録の許可を確認して再試行してください。"});
        }
        if (!content || contentError) {
            return LensResponse(@{@"error": @"画面を取得できませんでした。画面収録の許可を確認し、アプリを再起動してください。"});
        }
        SCDisplay *display = nil;
        for (SCDisplay *candidate in content.displays) {
            if (candidate.displayID == displayID) { display = candidate; break; }
        }
        if (!display) return LensResponse(@{@"error": @"対象の画面が見つかりません。レンズを移動して再試行してください。"});

        NSMutableArray<SCRunningApplication *> *excluded = [NSMutableArray array];
        for (SCRunningApplication *application in content.applications) {
            if (application.processID == NSProcessInfo.processInfo.processIdentifier) [excluded addObject:application];
        }
        if (!excluded.count) return LensResponse(@{@"error": @"レンズを画像から除外できませんでした。もう一度更新してください。"});
        // Exclude our whole app, including translated text, without flashing or hiding the lens.
        SCContentFilter *filter = [[SCContentFilter alloc] initWithDisplay:display
                                                   excludingApplications:excluded exceptingWindows:@[]];
        SCStreamConfiguration *configuration = [SCStreamConfiguration new];
        configuration.sourceRect = source;
        // Bound memory use while retaining Retina detail for ordinary lens sizes.
        scale = MIN(scale, 4096.0 / MAX(width, height));
        configuration.width = (size_t)ceil(width * scale);
        configuration.height = (size_t)ceil(height * scale);
        configuration.pixelFormat = kCVPixelFormatType_32BGRA;
        configuration.minimumFrameInterval = CMTimeMake(1, 5);
        configuration.queueDepth = 3;
        configuration.showsCursor = NO;
        configuration.capturesAudio = NO;
        PlamoLensFrame *frame = [PlamoLensFrame new];
        SCStream *stream = [[SCStream alloc] initWithFilter:filter configuration:configuration delegate:frame];
        NSError *error = nil;
        dispatch_queue_t queue = dispatch_queue_create("app.anywhere-plamo.lens", DISPATCH_QUEUE_SERIAL);
        if (![stream addStreamOutput:frame type:SCStreamOutputTypeScreen sampleHandlerQueue:queue error:&error]) {
            return LensResponse(@{@"error": @"画面取得を開始できませんでした。もう一度更新してください。"});
        }
        [stream startCaptureWithCompletionHandler:^(NSError *startError) {
            if (startError) [frame finish:NULL error:startError];
            // Also stop a delayed start after the worker has timed out.
            @synchronized (frame) {
                if (frame.finished) [stream stopCaptureWithCompletionHandler:^(NSError *stopError) {}];
            }
        }];
        if (dispatch_semaphore_wait(frame.ready, dispatch_time(DISPATCH_TIME_NOW, 10 * NSEC_PER_SEC))) {
            [frame finish:NULL error:LensError(@"画面の取得がタイムアウトしました。もう一度更新してください。")];
        }
        // Capture only one frame. Keep the stream alive until stopping completes.
        [stream stopCaptureWithCompletionHandler:^(NSError *stopError) { (void)stream; }];
        if (frame.error || !frame.image) {
            return LensResponse(@{@"error": frame.error.localizedDescription ?: @"画面を読み取れませんでした。"});
        }

        VNRecognizeTextRequest *request = [VNRecognizeTextRequest new];
        request.recognitionLevel = VNRequestTextRecognitionLevelAccurate;
        request.automaticallyDetectsLanguage = YES;
        request.usesLanguageCorrection = YES;
        // Revision 3 includes Japanese on our minimum supported macOS 13.3.
        request.revision = VNRecognizeTextRequestRevision3;
        VNImageRequestHandler *handler = [[VNImageRequestHandler alloc] initWithCVPixelBuffer:frame.image options:@{}];
        if (![handler performRequests:@[request] error:&error]) {
            return LensResponse(@{@"error": @"文字を認識できませんでした。範囲を変えて再試行してください。"});
        }
        NSMutableArray<NSString *> *lines = [NSMutableArray array];
        for (VNRecognizedTextObservation *observation in request.results) {
            NSString *text = [observation topCandidates:1].firstObject.string;
            if (text.length) [lines addObject:text];
        }
        return LensResponse(@{@"text": [lines componentsJoinedByString:@"\n"]});
    }
}

void plamo_lens_free(char *value) { free(value); }
