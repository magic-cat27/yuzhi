# plt.show() in a headless project run saves figures for the workspace preview.
import os
try:
    import matplotlib.pyplot as plt
    from matplotlib import font_manager
    available={font.name for font in font_manager.fontManager.ttflist}
    for name in ('Noto Sans CJK SC','WenQuanYi Zen Hei'):
        if name in available:
            plt.rcParams['font.sans-serif']=[name,'DejaVu Sans']
            plt.rcParams['axes.unicode_minus']=False
            break
    sequence=0
    def show(*args,**kwargs):
        global sequence
        os.makedirs('/workspace/artifacts',exist_ok=True)
        for number in plt.get_fignums():
            sequence+=1
            target=f'/workspace/artifacts/figure-{sequence}.png'
            plt.figure(number).savefig(target,bbox_inches='tight')
            print(f'图像已保存：artifacts/figure-{number}.png')
        plt.close('all')
    plt.show=show
except ImportError:
    pass
