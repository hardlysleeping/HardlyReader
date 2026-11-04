#import <UIKit/UIKit.h>

/// The status bar belongs to portrait.
///
/// On its side a phone has no room to give away: the bar is ~36pt of system
/// controls at the very top, and the clock, wifi and battery are drawn where the
/// reading bar wants to be — an iPad centres the clock besides, which lands it in
/// the middle of the title. `app.css` reserves no strip for it in landscape
/// ("Landscape reserves nothing at the top"), so the bar should not be there at
/// all.
///
/// A WKWebView cannot ask for this: `prefersStatusBarHidden` is answered by a
/// view controller, and the controller here belongs to Tauri's generated
/// template, which is a build product (`tauri ios init` regenerates it). What is
/// available is the global switch — with `UIViewControllerBasedStatusBarAppearance
/// = NO` in Info.plist (the release workflows set it) iOS honours
/// `-[UIApplication setStatusBarHidden:withAnimation:]` for the whole app, and
/// the orientation is the app's own business. Deprecated since iOS 9 and still
/// the only route from inside a webview.
///
/// **Why Objective-C and not Swift.** The launch hook is `+load`, which runs for
/// every class in a linked image before `main`. Swift refuses to compile a
/// `+load`: `method 'load()' defines Objective-C class method 'load', which is
/// not permitted by Swift` (measured — the first CI run of this fix failed on
/// exactly that line). Objective-C permits it, so the hook is here and nothing
/// else is: the decision it makes is three lines.
///
/// Deliberately landscape only. In portrait the clock is where the header's
/// `--status-lift` arithmetic expects it, and hiding the bar there would leave a
/// band of nothing under the Dynamic Island.
@interface HardlyReaderStatusBar : NSObject
@end

@implementation HardlyReaderStatusBar

/// A release check reads this back out of the packaged binary
/// (`strings` must contain it). A file that never entered the app target links
/// nothing and fails silently, which is what the workflows look for.
/// `used` is load-bearing: a `static` nothing reads is dead-stripped out of a
/// release archive, and the check would then fail on a build that works.
__attribute__((used)) static NSString *const HardlyReaderStatusBarMarker =
    @"hardlyreader-status-bar-1";

+ (void)load {
  [NSNotificationCenter.defaultCenter
      addObserverForName:UIApplicationDidBecomeActiveNotification
                  object:nil
                   queue:NSOperationQueue.mainQueue
              usingBlock:^(__unused NSNotification *note) {
                static BOOL started = NO;
                if (started) {
                  [self apply];
                  return;
                }
                started = YES;
                // Rotations are only delivered while this is on.
                [UIDevice.currentDevice beginGeneratingDeviceOrientationNotifications];
                [NSNotificationCenter.defaultCenter addObserver:self
                                                       selector:@selector(orientationChanged:)
                                                           name:UIDeviceOrientationDidChangeNotification
                                                         object:nil];
                [self apply];
              }];
}

+ (void)orientationChanged:(__unused NSNotification *)note {
  [self apply];
}

/// Hide the bar when the window scene is wider than it is tall.
///
/// The scene's `interfaceOrientation` rather than the screen's bounds: a screen's
/// bounds do not rotate, so a landscape window on a portrait device would ask the
/// wrong question and answer "portrait" while the reader is looking at 844 points
/// of width.
+ (void)apply {
  UIWindowScene *scene = nil;
  for (UIScene *candidate in UIApplication.sharedApplication.connectedScenes) {
    if (![candidate isKindOfClass:UIWindowScene.class]) continue;
    UIWindowScene *window = (UIWindowScene *)candidate;
    if (window.activationState == UISceneActivationStateForegroundActive) {
      scene = window;
      break;
    }
    if (scene == nil) scene = window;
  }
  BOOL landscape = scene != nil && UIInterfaceOrientationIsLandscape(scene.interfaceOrientation);
  // The marker keeps a symbol for this file in the binary even under -O; the
  // check greps for it by name.
  (void)HardlyReaderStatusBarMarker;
  [UIApplication.sharedApplication setStatusBarHidden:landscape
                                        withAnimation:UIStatusBarAnimationFade];
}

@end
