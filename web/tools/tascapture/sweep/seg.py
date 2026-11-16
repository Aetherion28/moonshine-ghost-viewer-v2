import cv2,numpy as np
def mask(im):
    h=cv2.cvtColor(im,cv2.COLOR_BGR2HSV)
    m=((h[...,0]<=20)|(h[...,0]>=170))&(h[...,1]>=50)&(h[...,1]<=175)&(h[...,2]>=165)
    m=m.astype(np.uint8)
    m[:22,:110]=0; m[30:118,195:]=0; m[150:,245:]=0
    m=cv2.morphologyEx(m,cv2.MORPH_OPEN,np.ones((3,3),np.uint8))
    m=cv2.morphologyEx(m,cv2.MORPH_CLOSE,np.ones((5,5),np.uint8))
    return m
