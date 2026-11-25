#undef _WIN32_WINNT
#define _WIN32_WINNT 0x0A00
#include <windows.h>
#include <commctrl.h>
#include <stdint.h>
#include <string.h>

#define TP ((POINTER_INPUT_TYPE)5)
#define SCID ((UINT_PTR)0xCA06)
#define CAP 128
typedef BOOL (WINAPI *RegisterFn)(HWND, BOOL);
typedef BOOL (WINAPI *FrameFn)(UINT32, UINT32*, POINTER_TOUCH_INFO*);
typedef struct { double x,y,square; int px,py; DWORD time; char phase; } Sample;
static RegisterFn setCap;
static FrameFn frameInfo;
static HWND root, child;
static Sample queue[CAP];
static unsigned used;
static DWORD lastFrame;
static UINT32 oldA,oldB;
static HANDLE oldDevice;
static BOOL pair;
static POINT anchor;

static void add(Sample s) {
    if (used==CAP) { used=0; queue[used++]=(Sample){.phase='c'}; if(s.phase=='m')s.phase='b'; }
    queue[used++]=s;
}
static void reset(char phase) {
    if (pair) add((Sample){.phase=phase,.time=GetTickCount()});
    pair=FALSE;
}
static void consume(UINT32 id, UINT msg) {
    UINT32 count=16, n=0;
    POINTER_TOUCH_INFO frames[16];
    POINTER_INFO p[2];
    if (!frameInfo(id,&count,frames) || count>16) { reset('c'); return; }
    for (UINT32 i=0;i<count;i++) {
        POINTER_INFO q=frames[i].pointerInfo;
        if(q.pointerType!=TP || !(q.pointerFlags&POINTER_FLAG_INCONTACT) ||
           (q.pointerFlags&POINTER_FLAG_CANCELED) ||
           (msg==WM_POINTERUP && q.pointerId==id))continue;
        if(n<2)p[n]=q;
        n++;
    }
    if(n!=2 || p[0].sourceDevice!=p[1].sourceDevice) { reset(n>2?'c':'e'); return; }
    UINT32 a=p[0].pointerId,b=p[1].pointerId;
    if(a>b){UINT32 swap=a;a=b;b=swap;}
    BOOL same=pair && a==oldA && b==oldB && p[0].sourceDevice==oldDevice;
    if(same && p[0].frameId==lastFrame)return;
    if(!same) {
        reset('c');
        if(!GetCursorPos(&anchor))anchor=p[0].ptPixelLocation;
        RECT rc; POINT pt=anchor;
        if(!GetClientRect(root,&rc)||!ScreenToClient(root,&pt)||!PtInRect(&rc,pt))return;
    }
    double ax=p[0].ptHimetricLocation.x,ay=p[0].ptHimetricLocation.y;
    double bx=p[1].ptHimetricLocation.x,by=p[1].ptHimetricLocation.y;
    add((Sample){(ax+bx)/2,(ay+by)/2,(ax-bx)*(ax-bx)+(ay-by)*(ay-by),
                 anchor.x,anchor.y,p[0].dwTime,same?'m':'b'});
    pair=TRUE;oldA=a;oldB=b;oldDevice=p[0].sourceDevice;lastFrame=p[0].frameId;
}
static LRESULT CALLBACK proc(HWND hwnd,UINT msg,WPARAM w,LPARAM l,UINT_PTR sub,DWORD_PTR ref) {
    (void)ref;
    if(msg==WM_NCDESTROY){
        setCap(hwnd,FALSE);
        RemoveWindowSubclass(hwnd,proc,sub);
        if(hwnd==child)child=NULL;
        if(hwnd==root)root=NULL;
        reset('c');
        return DefSubclassProc(hwnd,msg,w,l);
    }
    if(msg==WM_POINTERDOWN || msg==WM_POINTERUPDATE || msg==WM_POINTERUP || msg==WM_POINTERCAPTURECHANGED) {
        UINT32 id=LOWORD(w);
        POINTER_INPUT_TYPE type;
        if(GetPointerType(id,&type) && type==TP) {
            if(msg==WM_POINTERCAPTURECHANGED)reset('c');else consume(id,msg);
            return 0;
        }
    }
    return DefSubclassProc(hwnd,msg,w,l);
}
static BOOL hook(HWND h) {
    if(!SetWindowSubclass(h,proc,SCID,0))return FALSE;
    if(setCap(h,TRUE))return TRUE;
    RemoveWindowSubclass(h,proc,SCID);
    return FALSE;
}
static BOOL CALLBACK locate(HWND h,LPARAM arg) {
    WCHAR cls[64];
    if(GetWindowThreadProcessId(h,NULL)==GetCurrentThreadId() &&
        GetClassNameW(h,cls,64) && !lstrcmpW(cls,L"Chrome_RenderWidgetHostHWND")) {
        *(HWND*)arg=h;return FALSE;
    }
    return TRUE;
}
static void refresh(void) {
    if(!root || child)return;
    HWND h=NULL;
    EnumChildWindows(root,locate,(LPARAM)&h);
    if(h && hook(h))child=h;
}
static void uninstall(void) {
    if(child){setCap(child,FALSE);RemoveWindowSubclass(child,proc,SCID);child=NULL;}
    if(root){setCap(root,FALSE);RemoveWindowSubclass(root,proc,SCID);root=NULL;}
    pair=FALSE;used=0;
}

// Use Node-API exported by the running Electron executable, no Electron/Node ABI imports.
typedef void* Env;
typedef void* Value;
typedef void* Info;
typedef int Status;
typedef Value (*Callback)(Env,Info);
#define NAPIS(X) \
 X(napi_get_cb_info,(Env,Info,size_t*,Value*,Value*,void**)) \
 X(napi_get_buffer_info,(Env,Value,void**,size_t*)) \
 X(napi_get_boolean,(Env,bool,Value*)) \
 X(napi_get_undefined,(Env,Value*)) \
 X(napi_create_function,(Env,const char*,size_t,Callback,void*,Value*)) \
 X(napi_set_named_property,(Env,Value,const char*,Value)) \
 X(napi_create_array_with_length,(Env,size_t,Value*)) \
 X(napi_create_double,(Env,double,Value*)) \
 X(napi_set_element,(Env,Value,uint32_t,Value))
#define DECL(n,p) static Status (*n)p;
#include <stdbool.h>
NAPIS(DECL)
static Value start(Env e,Info i) {
    size_t n=1,len=0;
    Value arg,out=NULL;
    void *buf=NULL;
    BOOL ok=FALSE;
    if(!napi_get_cb_info(e,i,&n,&arg,NULL,NULL) && n==1 &&
       !napi_get_buffer_info(e,arg,&buf,&len) && len==sizeof(HWND)){
        HWND h;memcpy(&h,buf,sizeof h);
        HMODULE u=GetModuleHandleW(L"user32.dll");
        setCap=(RegisterFn)GetProcAddress(u,"RegisterTouchpadCapableWindow");
        frameInfo=(FrameFn)GetProcAddress(u,"GetPointerFrameTouchpadInfo");
        if(h==root && root) ok=TRUE;
        else if(setCap && frameInfo && h && GetWindowThreadProcessId(h,NULL)==GetCurrentThreadId()){
            uninstall();
            root=h;
            if(hook(h)){refresh();ok=TRUE;}else root=NULL;
        }
    }
    napi_get_boolean(e,ok!=FALSE,&out);return out;
}
static Value stop(Env e,Info i) {
    (void)i;uninstall();Value out=NULL;napi_get_undefined(e,&out);return out;
}
static Value poll(Env e,Info i) {
    (void)i; Value out=NULL;
    if(!root || !child)refresh();
    if(napi_create_array_with_length(e,used*7,&out))return NULL;
    for(unsigned j=0;j<used;j++){
        Sample s=queue[j];
        double vals[]={s.phase,s.x,s.y,s.square,s.px,s.py,s.time};
        for(unsigned k=0;k<7;k++){
            Value v;
            if(!napi_create_double(e,vals[k],&v))napi_set_element(e,out,j*7+k,v);
        }
    }
    used=0;return out;
}
__declspec(dllexport) Value napi_register_module_v1(Env e,Value exports) {
    HMODULE self=GetModuleHandleW(NULL);
#define LOAD(n,p) n=(Status (*)p)GetProcAddress(self,#n);if(!n)return exports;
    NAPIS(LOAD)
    const char *names[]={"start","stop","poll"};
    Callback callbacks[]={start,stop,poll};
    for(unsigned j=0;j<3;j++){
        Value v;
        if(!napi_create_function(e,names[j],strlen(names[j]),callbacks[j],NULL,&v))
            napi_set_named_property(e,exports,names[j],v);
    }
    return exports;
}
