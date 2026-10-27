#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>
#import <BackgroundTasks/BackgroundTasks.h>

// The launch-time half of the background refresh, in Objective-C because that
// is the only language with `+load`.
//
// `BGTaskScheduler` only accepts a registration *before the app finishes
// launching*; anything later throws. Swift has no `+load`, and the generated
// Xcode project has no AppDelegate of ours to add one to, so this six-line class
// is the hook: `+load` runs when the image loads, which is before `main`.
//
// The identifier is spelled here, in AppRefreshTask.swift and in the Info.plist
// fragment, because a launch handler registered under an identifier the plist
// does not permit is silently never launched. `tests/unit/ios-background-refresh.mjs`
// reads all three and fails if they disagree.
static NSString *const HRRefreshTaskIdentifier = @"ing.hardlysleep.hardlyreader.refresh";

// Exported by AppRefreshTask.swift with @_cdecl. Called after launch, so the
// Swift runtime is fully up by the time either one runs.
extern void hardlyreader_app_refresh_handle(void *task);
extern void hardlyreader_app_refresh_schedule(void);

@interface HRAppRefreshHook : NSObject
@end

@implementation HRAppRefreshHook

+ (void)load {
  [[BGTaskScheduler sharedScheduler]
      registerForTaskWithIdentifier:HRRefreshTaskIdentifier
                         usingQueue:nil
                      launchHandler:^(BGTask *task) {
                        hardlyreader_app_refresh_handle((__bridge void *)task);
                      }];

  // Nothing asks for the first wake on its own: a refresh request is only
  // meaningful once the app has been backgrounded, so that is the moment it is
  // submitted. Every later one is submitted by the run that just finished.
  [[NSNotificationCenter defaultCenter]
      addObserverForName:UIApplicationDidEnterBackgroundNotification
                  object:nil
                   queue:nil
              usingBlock:^(NSNotification *note) {
                hardlyreader_app_refresh_schedule();
              }];
}

@end
