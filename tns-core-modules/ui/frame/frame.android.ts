﻿// Definitions.
import {
    AndroidFrame as AndroidFrameDefinition, BackstackEntry,
    NavigationTransition, AndroidFragmentCallbacks, AndroidActivityCallbacks
} from ".";
import { Page } from "../page";

// Types.
import { FrameBase, application, NavigationContext, stack, goBack, View, Observable, traceEnabled, traceWrite, traceCategories } from "./frame-common";
import { DIALOG_FRAGMENT_TAG } from "../page/constants";
import { _setAndroidFragmentTransitions, _waitForAnimationEnd, _onFragmentCreateAnimator, _updateAnimationFragment } from "./fragment.transitions";

import { profile } from "../../profiling";

export * from "./frame-common";

const HIDDEN = "_hidden";
const INTENT_EXTRA = "com.tns.activity";
const FRAMEID = "_frameId";
const CALLBACKS = "_callbacks";
let navDepth = -1;
let fragmentId = -1;
let activityInitialized: boolean;

export class Frame extends FrameBase {
    private _android: AndroidFrame;
    private _delayedNavigationEntry: BackstackEntry;
    private _containerViewId: number = -1;
    private _isBack: boolean = true;

    constructor() {
        super();
        this._android = new AndroidFrame(this);
    }

    public static get defaultAnimatedNavigation(): boolean {
        return FrameBase.defaultAnimatedNavigation;
    }
    public static set defaultAnimatedNavigation(value: boolean) {
        FrameBase.defaultAnimatedNavigation = value;
    }

    public static get defaultTransition(): NavigationTransition {
        return FrameBase.defaultTransition;
    }
    public static set defaultTransition(value: NavigationTransition) {
        FrameBase.defaultTransition = value;
    }

    get containerViewId(): number {
        return this._containerViewId;
    }

    get android(): AndroidFrame {
        return this._android;
    }

    private createFragment(backstackEntry: BackstackEntry, fragmentTag: string): android.app.Fragment {
        ensureFragmentClass();
        const newFragment: android.app.Fragment = new fragmentClass();
        const args = new android.os.Bundle();
        args.putInt(FRAMEID, this._android.frameId);
        newFragment.setArguments(args);
        setFragmentCallbacks(newFragment);

        const callbacks = newFragment[CALLBACKS];
        callbacks.frame = this;
        callbacks.entry = backstackEntry;

        // backstackEntry
        backstackEntry.fragmentTag = fragmentTag;
        backstackEntry.navDepth = navDepth;

        return newFragment;
    }

    public setCurrent(entry: BackstackEntry): void {
        this.changeCurrentPage(entry);
        this._currentEntry = entry;
        this._isBack = true;
        this._processNavigationQueue(entry.resolvedPage);
    }

    private changeCurrentPage(entry: BackstackEntry) {
        const isBack = this._isBack;
        let page: Page = this.currentPage;
        if (page) {
            if (page.frame === this && isBack) {
                this._removeView(page);
            }

            if (page.isLoaded) {
                // Forward navigation does not remove page from frame so we raise unloaded manually.
                page.onUnloaded();
            }

            page.onNavigatedFrom(isBack);
        }

        const newPage = entry.resolvedPage;
        newPage._fragmentTag = entry.fragmentTag;
        this._currentEntry = entry;
        newPage.onNavigatedTo(isBack);
    }

    @profile
    public _navigateCore(backstackEntry: BackstackEntry) {
        super._navigateCore(backstackEntry);
        this._isBack = false;

        const activity = this._android.activity;
        if (!activity) {
            // Activity not associated. In this case we have two execution paths:
            // 1. This is the main frame for the application
            // 2. This is an inner frame which requires a new Activity
            const currentActivity = this._android.currentActivity;
            if (currentActivity) {
                startActivity(currentActivity, this._android.frameId);
            }

            this._delayedNavigationEntry = backstackEntry;
            return;
        }

        const manager = activity.getFragmentManager();

        // Current Fragment
        const currentFragment = this._currentEntry ? manager.findFragmentByTag(this._currentEntry.fragmentTag) : null;
        const clearHistory = backstackEntry.entry.clearHistory;

        // New Fragment
        if (clearHistory) {
            navDepth = -1;
        }

        navDepth++;
        fragmentId++;
        const newFragmentTag = `fragment${fragmentId}[${navDepth}]`;
        const newFragment = this.createFragment(backstackEntry, newFragmentTag);
        const fragmentTransaction = manager.beginTransaction();

        const animated = this._getIsAnimatedNavigation(backstackEntry.entry);
        const navigationTransition = this._getNavigationTransition(backstackEntry.entry);

        _setAndroidFragmentTransitions(animated, navigationTransition, currentFragment, newFragment, fragmentTransaction, manager);
        if (currentFragment) {
            if (clearHistory) {
                removeFragments(manager, fragmentTransaction);
            } else {
                fragmentTransaction.addToBackStack(this._currentEntry.fragmentTag);
            }

            if (animated && !navigationTransition) {
                fragmentTransaction.setTransition(android.app.FragmentTransaction.TRANSIT_FRAGMENT_OPEN);
            }
        }

        fragmentTransaction.replace(this.containerViewId, newFragment, newFragmentTag);
        fragmentTransaction.commit();

        if (clearHistory) {
            manager.popBackStackImmediate(null, android.app.FragmentManager.POP_BACK_STACK_INCLUSIVE);
        }
    }

    public _goBackCore(backstackEntry: BackstackEntry) {
        super._goBackCore(backstackEntry);

        navDepth = backstackEntry.navDepth;
        const manager = this._android.activity.getFragmentManager();
        if (manager.getBackStackEntryCount() > 0) {
            const fragmentInBackstack = manager.findFragmentByTag(backstackEntry.fragmentTag);
            const currentFragment = manager.findFragmentByTag(this._currentEntry.fragmentTag);

            _waitForAnimationEnd(fragmentInBackstack, currentFragment);
            // pop all other fragments up until the named one
            // this handles cases where user may navigate to an inner page without adding it on the backstack
            manager.popBackStack(backstackEntry.fragmentTag, android.app.FragmentManager.POP_BACK_STACK_INCLUSIVE);
        }
    }

    public createNativeView() {
        const root = new org.nativescript.widgets.ContentLayout(this._context);
        if (this._containerViewId < 0) {
            this._containerViewId = android.view.View.generateViewId();
        }
        return root;
    }

    public initNativeView(): void {
        super.initNativeView();
        this._android.rootViewGroup = this.nativeViewProtected;
        this._android.rootViewGroup.setId(this._containerViewId);
    }

    public disposeNativeView() {
        // we should keep the reference to underlying native object, since frame can contain many pages.
        this._android.rootViewGroup = null;
        super.disposeNativeView();
    }

    public _popFromFrameStack() {
        if (!this._isInFrameStack) {
            return;
        }

        super._popFromFrameStack();
        if (this._android.hasOwnActivity) {
            this._android.activity.finish();
        }
    }

    public _printNativeBackStack() {
        if (!this._android.activity) {
            return;
        }
        const manager = this._android.activity.getFragmentManager();
        const length = manager.getBackStackEntryCount();
        let i = length - 1;
        console.log(`Fragment Manager Back Stack: `);
        while (i >= 0) {
            const fragment = manager.findFragmentByTag(manager.getBackStackEntryAt(i--).getName());
            console.log(`\t${fragment}`);
        }
    }

    public _getNavBarVisible(page: Page): boolean {
        if (page.actionBarHidden !== undefined) {
            return !page.actionBarHidden;
        }

        if (this._android && this._android.showActionBar !== undefined) {
            return this._android.showActionBar;
        }

        return true;
    }

    protected _processNavigationContext(navigationContext: NavigationContext) {
        let activity = this._android.activity;
        if (activity) {
            let isForegroundActivity = activity === application.android.foregroundActivity;
            let isPaused = application.android.paused;

            if (activity && !isForegroundActivity || (isForegroundActivity && isPaused)) {
                let weakActivity = new WeakRef(activity);
                let resume = (args: application.AndroidActivityEventData) => {
                    let weakActivityInstance = weakActivity.get();
                    let isCurrent = args.activity === weakActivityInstance;
                    if (!weakActivityInstance) {
                        if (traceEnabled()) {
                            traceWrite(`Frame _processNavigationContext: Drop For Activity GC-ed`, traceCategories.Navigation);
                        }
                        unsubscribe();
                        return;
                    }
                    if (isCurrent) {
                        if (traceEnabled()) {
                            traceWrite(`Frame _processNavigationContext: Activity.Resumed, Continue`, traceCategories.Navigation);
                        }
                        super._processNavigationContext(navigationContext);
                        unsubscribe();
                    }
                };
                let unsubscribe = () => {
                    if (traceEnabled()) {
                        traceWrite(`Frame _processNavigationContext: Unsubscribe from Activity.Resumed`, traceCategories.Navigation);
                    }
                    application.android.off(application.AndroidApplication.activityResumedEvent, resume);
                    application.android.off(application.AndroidApplication.activityStoppedEvent, unsubscribe);
                    application.android.off(application.AndroidApplication.activityDestroyedEvent, unsubscribe);
                };

                if (traceEnabled()) {
                    traceWrite(`Frame._processNavigationContext: Subscribe for Activity.Resumed`, traceCategories.Navigation);
                }
                application.android.on(application.AndroidApplication.activityResumedEvent, resume);
                application.android.on(application.AndroidApplication.activityStoppedEvent, unsubscribe);
                application.android.on(application.AndroidApplication.activityDestroyedEvent, unsubscribe);
                return;
            }
        }
        super._processNavigationContext(navigationContext);
    }
}

function removeFragments(manager: android.app.FragmentManager, ft: android.app.FragmentTransaction): void {
    if (traceEnabled()) {
        traceWrite(`CLEAR HISTORY`, traceCategories.Navigation);
    }

    for (let i = manager.getBackStackEntryCount() - 1; i >= 0; i--) {
        const fragment = manager.findFragmentByTag(manager.getBackStackEntryAt(i).getName());
        ft.detach(fragment);
        const page = fragment[CALLBACKS].entry.resolvedPage;
        if (page.frame) {
            page.frame._removeView(page);
        }
    }
}

let framesCounter = 0;
let framesCache: Array<WeakRef<AndroidFrame>> = new Array<WeakRef<AndroidFrame>>();

class AndroidFrame extends Observable implements AndroidFrameDefinition {
    public rootViewGroup: android.view.ViewGroup;
    public hasOwnActivity = false;
    public frameId;

    private _showActionBar = true;
    private _owner: Frame;
    public cachePagesOnNavigate: boolean = true;

    constructor(owner: Frame) {
        super();
        this._owner = owner;
        this.frameId = framesCounter++;
        framesCache.push(new WeakRef(this));
    }

    public get showActionBar(): boolean {
        return this._showActionBar;
    }

    public set showActionBar(value: boolean) {
        if (this._showActionBar !== value) {
            this._showActionBar = value;
            if (this.owner.currentPage) {
                this.owner.currentPage.actionBar.update();
            }
        }
    }

    public get activity(): android.app.Activity {
        let activity: android.app.Activity = this.owner._context;
        if (activity) {
            return activity;
        }

        // traverse the parent chain for an ancestor Frame
        let currView = this._owner.parent;
        while (currView) {
            if (currView instanceof Frame) {
                return (<Frame>currView).android.activity;
            }

            currView = currView.parent;
        }

        return undefined;
    }

    public get actionBar(): android.app.ActionBar {
        let activity = this.currentActivity;
        if (!activity) {
            return undefined;
        }

        let bar = activity.getActionBar();
        if (!bar) {
            return undefined;
        }

        return bar;
    }

    public get currentActivity(): android.app.Activity {
        let activity = this.activity;
        if (activity) {
            return activity;
        }

        let frames = stack();
        for (let length = frames.length, i = length - 1; i >= 0; i--) {
            activity = frames[i].android.activity;
            if (activity) {
                return activity;
            }
        }

        return undefined;
    }

    public get owner(): Frame {
        return this._owner;
    }

    public canGoBack() {
        if (!this.activity) {
            return false;
        }

        // can go back only if it is not the main one.
        return this.activity.getIntent().getAction() !== android.content.Intent.ACTION_MAIN;
    }

    public fragmentForPage(page: Page): any {
        if (!page) {
            return undefined;
        }

        let tag = page._fragmentTag;
        if (tag) {
            let manager = this.activity.getFragmentManager();
            return manager.findFragmentByTag(tag);
        }

        return undefined;
    }
}

function findPageForFragment(fragment: android.app.Fragment, frame: Frame) {
    const fragmentTag = fragment.getTag();
    if (traceEnabled()) {
        traceWrite(`Finding page for ${fragmentTag}.`, traceCategories.NativeLifecycle);
    }

    if (fragmentTag === DIALOG_FRAGMENT_TAG) {
        return;
    }

    let entry: BackstackEntry;
    if (frame._currentEntry && frame._currentEntry.fragmentTag === fragmentTag) {
        entry = frame._currentEntry;
    } else {
        entry = frame.backStack.find((value) => value.fragmentTag === fragmentTag);
    }

    const page = entry ? entry.resolvedPage : undefined;
    if (page) {
        const callbacks: FragmentCallbacksImplementation = fragment[CALLBACKS];
        callbacks.frame = frame;
        callbacks.entry = entry;
        _updateAnimationFragment(fragment);
    } else {
        throw new Error(`Could not find a page for ${fragmentTag}.`);
    }
}

function startActivity(activity: android.app.Activity, frameId: number) {
    // TODO: Implicitly, we will open the same activity type as the current one
    const intent = new android.content.Intent(activity, activity.getClass());
    intent.setAction(android.content.Intent.ACTION_DEFAULT);
    intent.putExtra(INTENT_EXTRA, frameId);

    // TODO: Put the navigation context (if any) in the intent
    activity.startActivity(intent);
}

function getFrameById(frameId: number): Frame {
    // Find the frame for this activity.
    for (let i = 0; i < framesCache.length; i++) {
        let aliveFrame = framesCache[i].get();
        if (aliveFrame && aliveFrame.frameId === frameId) {
            return aliveFrame.owner;
        }
    }

    return null;
}

function ensureFragmentClass() {
    if (fragmentClass) {
        return;
    }

    // this require will apply the FragmentClass implementation 
    require("ui/frame/fragment");

    if (!fragmentClass) {
        throw new Error("Failed to initialize the extended android.app.Fragment class");
    }
}

let fragmentClass: any;
export function setFragmentClass(clazz: any) {
    if (fragmentClass) {
        throw new Error("Fragment class already initialized");
    }

    fragmentClass = clazz;
}

class FragmentCallbacksImplementation implements AndroidFragmentCallbacks {
    public frame: Frame;
    public entry: BackstackEntry;

    @profile
    public onHiddenChanged(fragment: android.app.Fragment, hidden: boolean, superFunc: Function): void {
        if (traceEnabled()) {
            traceWrite(`${fragment}.onHiddenChanged(${hidden})`, traceCategories.NativeLifecycle);
        }
        superFunc.call(fragment, hidden);
    }

    @profile
    public onCreateAnimator(fragment: android.app.Fragment, transit: number, enter: boolean, nextAnim: number, superFunc: Function): android.animation.Animator {
        let nextAnimString: string;
        switch (nextAnim) {
            case -10: nextAnimString = "enter"; break;
            case -20: nextAnimString = "exit"; break;
            case -30: nextAnimString = "popEnter"; break;
            case -40: nextAnimString = "popExit"; break;
        }

        let animator = _onFragmentCreateAnimator(fragment, nextAnim);
        if (!animator) {
            animator = superFunc.call(fragment, transit, enter, nextAnim);
        }

        if (traceEnabled()) {
            traceWrite(`${fragment}.onCreateAnimator(${transit}, ${enter ? "enter" : "exit"}, ${nextAnimString}): ${animator ? 'animator' : 'no animator'}`, traceCategories.NativeLifecycle);
        }
        return animator;
    }

    @profile
    public onCreate(fragment: android.app.Fragment, savedInstanceState: android.os.Bundle, superFunc: Function): void {
        if (traceEnabled()) {
            traceWrite(`${fragment}.onCreate(${savedInstanceState})`, traceCategories.NativeLifecycle);
        }

        superFunc.call(fragment, savedInstanceState);
        // There is no entry set to the fragment, so this must be destroyed fragment that was recreated by Android.
        // We should find its corresponding page in our backstack and set it manually.
        if (!this.entry) {
            const frameId = fragment.getArguments().getInt(FRAMEID);
            const frame = getFrameById(frameId);
            if (!frame) {
                throw new Error(`Cannot find Frame for ${fragment}`);
            }

            findPageForFragment(fragment, frame);
        }
    }

    @profile
    public onCreateView(fragment: android.app.Fragment, inflater: android.view.LayoutInflater, container: android.view.ViewGroup, savedInstanceState: android.os.Bundle, superFunc: Function): android.view.View {
        if (traceEnabled()) {
            traceWrite(`${fragment}.onCreateView(inflater, container, ${savedInstanceState})`, traceCategories.NativeLifecycle);
        }

        const entry = this.entry;
        const page = entry.resolvedPage;
        try {
            if (savedInstanceState && savedInstanceState.getBoolean(HIDDEN, false)) {
                fragment.getFragmentManager().beginTransaction().hide(fragment).commit();
            }

            const frame = this.frame;
            if (page.parent === frame) {
                if (frame.isLoaded && !page.isLoaded) {
                    page.onLoaded();
                }
            } else {
                this.frame._addView(page);
            }
        } catch (ex) {
            const label = new android.widget.TextView(container.getContext());
            label.setText(ex.message + ", " + ex.stackTrace);
            return label;
        }

        return page.nativeViewProtected;
    }

    @profile
    public onSaveInstanceState(fragment: android.app.Fragment, outState: android.os.Bundle, superFunc: Function): void {
        if (traceEnabled()) {
            traceWrite(`${fragment}.onSaveInstanceState(${outState})`, traceCategories.NativeLifecycle);
        }
        superFunc.call(fragment, outState);
        if (fragment.isHidden()) {
            outState.putBoolean(HIDDEN, true);
        }
    }

    @profile
    public onDestroyView(fragment: android.app.Fragment, superFunc: Function): void {
        const entry = this.entry;
        const page = entry.resolvedPage;
        if (traceEnabled()) {
            traceWrite(`${fragment}.onDestroyView()`, traceCategories.NativeLifecycle);
        }
        superFunc.call(fragment);
    }

    @profile
    public onDestroy(fragment: android.app.Fragment, superFunc: Function): void {
        const entry = this.entry;
        const page = entry.resolvedPage;
        superFunc.call(fragment);

        const frame = page.frame;
        // This will happen if we navigate forward then kill the app
        // Existing pages will be in the frame so we need to destory them.
        if (frame && !frame.isCurrent(entry)) {
            frame._removeView(page);
        }
    }

    @profile
    public toStringOverride(fragment: android.app.Fragment, superFunc: Function): string {
        return `${fragment.getTag()}<${this.entry ? this.entry.resolvedPage : ""}>`;
    }
}

class ActivityCallbacksImplementation implements AndroidActivityCallbacks {
    private _rootView: View;

    @profile
    public onCreate(activity: android.app.Activity, savedInstanceState: android.os.Bundle, superFunc: Function): void {
        if (traceEnabled()) {
            traceWrite(`Activity.onCreate(${savedInstanceState})`, traceCategories.NativeLifecycle);
        }

        const app = application.android;
        const intent = activity.getIntent();
        const launchArgs: application.LaunchEventData = { eventName: application.launchEvent, object: app, android: intent };
        application.notify(launchArgs);

        let frameId = -1;
        let rootView = launchArgs.root;
        const extras = intent.getExtras();

        // We have extras when we call - new Frame().navigate();
        // savedInstanceState is used when activity is recreated.
        // NOTE: On API 23+ we get extras on first run.
        // Check changed - first try to get frameId from Extras if not from saveInstanceState.
        if (extras) {
            frameId = extras.getInt(INTENT_EXTRA, -1);
        }

        if (savedInstanceState && frameId < 0) {
            frameId = savedInstanceState.getInt(INTENT_EXTRA, -1);
        }

        // If we have frameId from extras - we are starting a new activity from navigation (e.g. new Frame().navigate()))
        // Then we check if we have frameId from savedInstanceState - this happens when Activity is destroyed but app was not (e.g. suspend)
        // Only then we fallback to the view returned from the event. This is done in order to have backwards compatibility (remove it for 2.0.0).
        let frame: Frame;
        let navParam;
        if (frameId >= 0) {
            rootView = getFrameById(frameId);
        }

        if (!rootView) {
            navParam = application.getMainEntry();

            if (navParam) {
                frame = new Frame();
            } else {
                // TODO: Throw an exception?
                throw new Error("A Frame must be used to navigate to a Page.");
            }

            rootView = frame;
        }

        // If there is savedInstanceState this call will recreate all fragments that were previously in the navigation.
        // We take care of associating them with a Page from our backstack in the onAttachFragment callback.
        // If there is savedInstanceState and activityInitialized is false we are restarted but process was killed.
        // For now we treat it like first run (e.g. we are not passing savedInstanceState so no fragments are being restored).
        // When we add support for application save/load state - revise this logic.
        let isRestart = !!savedInstanceState && activityInitialized;
        superFunc.call(activity, isRestart ? savedInstanceState : null);

        this._rootView = rootView;

        // Initialize native visual tree;
        rootView._setupUI(activity);
        activity.setContentView(rootView.nativeViewProtected, new org.nativescript.widgets.CommonLayoutParams());
        // frameId is negative w
        if (frame) {
            frame.navigate(navParam);
        }

        activityInitialized = true;
    }

    @profile
    public onSaveInstanceState(activity: android.app.Activity, outState: android.os.Bundle, superFunc: Function): void {
        superFunc.call(activity, outState);
        let view = this._rootView;
        if (view instanceof Frame) {
            outState.putInt(INTENT_EXTRA, view.android.frameId);
        }
    }

    @profile
    public onStart(activity: any, superFunc: Function): void {
        superFunc.call(activity);

        if (traceEnabled()) {
            traceWrite("NativeScriptActivity.onStart();", traceCategories.NativeLifecycle);
        }
        let rootView = this._rootView;
        if (rootView && !rootView.isLoaded) {
            rootView.onLoaded();
        }
    }

    @profile
    public onStop(activity: any, superFunc: Function): void {
        superFunc.call(activity);

        if (traceEnabled()) {
            traceWrite("NativeScriptActivity.onStop();", traceCategories.NativeLifecycle);
        }
        let rootView = this._rootView;
        if (rootView && rootView.isLoaded) {
            rootView.onUnloaded();
        }
    }

    @profile
    public onDestroy(activity: any, superFunc: Function): void {
        let rootView = this._rootView;
        if (rootView && rootView._context) {
            rootView._tearDownUI(true);
        }

        superFunc.call(activity);

        if (traceEnabled()) {
            traceWrite("NativeScriptActivity.onDestroy();", traceCategories.NativeLifecycle);
        }

        const exitArgs = { eventName: application.exitEvent, object: application.android, android: activity };
        application.notify(exitArgs);
    }

    @profile
    public onBackPressed(activity: any, superFunc: Function): void {
        if (traceEnabled()) {
            traceWrite("NativeScriptActivity.onBackPressed;", traceCategories.NativeLifecycle);
        }

        const args = <application.AndroidActivityBackPressedEventData>{
            eventName: "activityBackPressed",
            object: application.android,
            activity: activity,
            cancel: false,
        };
        application.android.notify(args);

        if (args.cancel) {
            return;
        }

        if (!goBack()) {
            superFunc.call(activity);
        }
    }

    @profile
    public onRequestPermissionsResult(activity: any, requestCode: number, permissions: Array<String>, grantResults: Array<number>, superFunc: Function): void {
        if (traceEnabled()) {
            traceWrite("NativeScriptActivity.onRequestPermissionsResult;", traceCategories.NativeLifecycle);
        }

        application.android.notify(<application.AndroidActivityRequestPermissionsEventData>{
            eventName: "activityRequestPermissions",
            object: application.android,
            activity: activity,
            requestCode: requestCode,
            permissions: permissions,
            grantResults: grantResults
        });
    }

    @profile
    public onActivityResult(activity: any, requestCode: number, resultCode: number, data: android.content.Intent, superFunc: Function): void {
        superFunc.call(activity, requestCode, resultCode, data);
        if (traceEnabled()) {
            traceWrite(`NativeScriptActivity.onActivityResult(${requestCode}, ${resultCode}, ${data})`, traceCategories.NativeLifecycle);
        }

        application.android.notify(<application.AndroidActivityResultEventData>{
            eventName: "activityResult",
            object: application.android,
            activity: activity,
            requestCode: requestCode,
            resultCode: resultCode,
            intent: data
        });
    }
}

export function setActivityCallbacks(activity: android.app.Activity): void {
    activity[CALLBACKS] = new ActivityCallbacksImplementation();
}

export function setFragmentCallbacks(fragment: android.app.Fragment): void {
    fragment[CALLBACKS] = new FragmentCallbacksImplementation();
}
