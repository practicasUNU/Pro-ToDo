"""
Genera `presentacion-minima.pptx`: una presentacion de una diapositiva con
dos formas de texto. La lee `officeparser` en
`document-extractor.util.spec.ts`.

El binario se versiona porque construirlo dentro de la prueba ataria el
fixture a la libreria que se quiere ejercitar. Este generador se versiona
al lado para que el binario no sea opaco en una revision, igual que
`nota-nativa.ps` acompana a `nota-nativa.pdf`. Solo usa la biblioteca
estandar de Python: no hace falta LibreOffice ni ningun binario del
sistema.

Uso:
    python3 presentacion-minima.gen.py <ruta-de-salida>
"""
import zipfile, sys

CT = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
<Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
</Types>'''

ROOT_RELS = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
</Relationships>'''

PRES = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
<p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst>
<p:sldSz cx="9144000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/>
</p:presentation>'''

PRES_RELS = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>
</Relationships>'''

def para(text):
    return ('<a:p><a:r><a:rPr lang="es-ES" dirty="0"/><a:t>' + text + '</a:t></a:r></a:p>')

SLIDE = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
<p:cSld><p:spTree>
<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
<p:grpSpPr/>
<p:sp><p:nvSpPr><p:cNvPr id="2" name="Titulo"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr/>
<p:txBody><a:bodyPr/><a:lstStyle/>''' + para('Nueva sede corporativa en Madrid') + '''</p:txBody></p:sp>
<p:sp><p:nvSpPr><p:cNvPr id="3" name="Cuerpo"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr/>
<p:txBody><a:bodyPr/><a:lstStyle/>''' + para('Doscientos empleos directos en la region') + '''</p:txBody></p:sp>
</p:spTree></p:cSld><p:clrMapOvr><a:overrideClrMapping bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/></p:clrMapOvr>
</p:sld>'''

with zipfile.ZipFile(sys.argv[1], 'w', zipfile.ZIP_DEFLATED) as z:
    z.writestr('[Content_Types].xml', CT)
    z.writestr('_rels/.rels', ROOT_RELS)
    z.writestr('ppt/presentation.xml', PRES)
    z.writestr('ppt/_rels/presentation.xml.rels', PRES_RELS)
    z.writestr('ppt/slides/slide1.xml', SLIDE)
print('escrito', sys.argv[1])
